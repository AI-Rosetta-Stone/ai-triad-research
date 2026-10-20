// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * Direct-write-mode (non-overlay) 409/write-conflict tests for GitHubAPIBackend,
 * plus readFileWithVersion atomicity — split out of githubApi.test.ts (t/4184,
 * t/4187, p/775#36) because that file hit its max-lines ceiling (2000) once
 * #3280's t/4201 block landed on main, per the project's split-on-budget
 * convention (ADR-007). Minimal self-contained mock harness mirroring
 * githubApi.test.ts's setup — see that file for the full GitHub API mock
 * surface this doesn't need (branches, PRs, merges, etc.). Overlay-path
 * baseSha precondition tests live in githubApiOverlayPrecondition.test.ts.
 *
 * LOCAL-ONLY FAILURE MODE (t/2281/t/3444): see githubApi.test.ts header — these
 * tests are gated on isUndiciMajorAlignedWithRuntime() for the same reason.
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

const fetchCalls: Array<{ url: string; method: string; body?: unknown }> = [];

type MockHandler = (url: string, init: RequestInit) => { status: number; body?: unknown } | null;
let apiHandlers: MockHandler[] = [];

const defaultRateLimitHeaders = {
  'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000',
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
};

function mockFetchResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: new Headers(defaultRateLimitHeaders) });
}

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
  fetchCalls.length = 0;
  apiHandlers = [];
  vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test');
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    fetchCalls.push({ url, method, body });

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
    cacheDir: '/var/cache/taxonomy-test', // non-tmpdir: breaks CodeQL /tmp taint flow (t/2020)
    recorder: recorder ?? createTestRecorder(),
    pollIntervalMs: 999_999_999,
    coherencyProbeRate: 0,
  });
  await backend.initialize();
  return backend;
}

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — direct-write-mode 409 handling (t/4184, t/4187)', () => {
  // t/4184 (SO e/300#3, C2 — actual scope): a retry-with-the-same-content on
  // a 409 is a lost update. The real vector this fix catches is a BASE-BRANCH
  // write whose SERVER CACHE is behind GitHub (another replica, another
  // process, or a direct out-of-band commit) — not two tabs on one backend
  // instance (same-instance writes never 409; getFileSha serves the prior
  // write's fresh cached SHA, so the second write just succeeds and silently
  // overwrites — that's the separate client-carried-SHA gap tracked as t/4187).
  it('never retries a 409 SHA conflict — fails loud instead of resending stale content (direct write mode)', async () => {
    const recorder = createTestRecorder();
    const backend = await createBackend(recorder);
    // No session context → writeFile uses Contents API directly

    let putCount = 0;
    apiHandlers.push((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'PUT' && url.includes('/contents/')) {
        putCount++;
        // Simulates a stale server cache: the SHA we send no longer matches
        // GitHub's real state. A retry-with-same-content bug would eventually
        // "succeed" by overwriting whatever moved the real SHA — so success
        // here would be the regression.
        return { status: 409, body: { message: 'sha does not match' } };
      }
      return null;
    });

    const err = await backend.writeFile('/taxonomy/nodes.json', '{"my-stale-write": true}')
      .then(() => null, (e: unknown) => e) as { httpStatus?: number; code?: string } | null;

    expect(err).not.toBeNull();
    expect(err?.httpStatus).toBe(409);
    expect(err?.code).toBe('WRITE_CONFLICT');
    // Exactly one PUT attempt — no retry with the stale content.
    expect(putCount).toBe(1);

    // Verify flight recorder logged the conflict (no silent failure).
    const conflictEvent = recorder.events.find(e => e.type === 'github.api.conflict');
    expect(conflictEvent).toBeDefined();
    expect(conflictEvent!.data).toMatchObject({ path: 'taxonomy/nodes.json' });

    backend.shutdown();
  });

  // SO C1 + C2: build the regression test on the real vector (server cache
  // stale via an out-of-band commit), assert eviction fixes the reload loop,
  // and assert both commits (the out-of-band one, then this one) land intact.
  it('evicts the stale cache entry on a 409 so reload sees the real GitHub state, and a fresh write then succeeds (direct write mode)', async () => {
    // SO e/300#5: the eviction must be PERSISTED (withManifestLock + saveManifest),
    // not just held in memory — otherwise a restart reloads the stale manifest
    // entry from disk and the reload loop comes back.
    const fsPromises = await import('fs/promises');
    const mockWriteFile = vi.mocked(fsPromises.default.writeFile);
    mockWriteFile.mockClear();

    const backend = await createBackend();
    // No session context → writeFile uses Contents API directly

    let realSha = 'sha-v1';
    let realContent = JSON.stringify({ source: 'original' });
    let putCount = 0;

    apiHandlers.push((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/contents/')) {
        return { status: 200, body: { content: Buffer.from(realContent).toString('base64'), encoding: 'base64', sha: realSha } };
      }
      if (method === 'PUT' && url.includes('/contents/')) {
        putCount++;
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        if (body?.sha !== realSha) {
          return { status: 409, body: { message: 'sha does not match' } };
        }
        realSha = `sha-v${putCount + 1}`;
        realContent = Buffer.from(body.content, 'base64').toString('utf-8');
        return { status: 200, body: { content: { sha: realSha } } };
      }
      return null;
    });

    // Prime the backend's cache at sha-v1 via a successful read.
    await backend.readFile('/taxonomy/nodes.json');

    // Out-of-band commit (another replica / process / direct GitHub commit) —
    // the backend's cache doesn't know yet, it still thinks sha-v1.
    realSha = 'sha-v2';
    realContent = JSON.stringify({ source: 'out-of-band' });

    const err = await backend.writeFile('/taxonomy/nodes.json', JSON.stringify({ source: 'stale-write' }))
      .then(() => null, (e: unknown) => e) as { httpStatus?: number; code?: string } | null;

    expect(err?.httpStatus).toBe(409);
    expect(err?.code).toBe('WRITE_CONFLICT');

    // The eviction was persisted to the on-disk manifest (not memory-only) —
    // find the manifest write that followed the conflict and confirm the
    // evicted path isn't in it. Manifest writes go to a tmp file before the
    // atomic rename (saveManifest()).
    const manifestWrites = mockWriteFile.mock.calls.filter(
      ([p]) => typeof p === 'string' && p.includes('manifest.json.tmp'),
    );
    expect(manifestWrites.length).toBeGreaterThan(0);
    const lastManifestWrite = JSON.parse(manifestWrites[manifestWrites.length - 1][1] as string);
    expect(lastManifestWrite.files['taxonomy/nodes.json']).toBeUndefined();

    // Without eviction this would 409 forever: reload would re-serve the same
    // stale cached content/SHA. With eviction, the next read is a cache miss
    // and fetches the real (out-of-band) state.
    const reloaded = await backend.readFile('/taxonomy/nodes.json');
    expect(reloaded).toBe(JSON.stringify({ source: 'out-of-band' }));

    // A write with the now-current SHA succeeds — both commits are intact on
    // GitHub (the out-of-band one, then this one), neither silently lost.
    await backend.writeFile('/taxonomy/nodes.json', JSON.stringify({ source: 'merged' }));
    expect(realContent).toBe(JSON.stringify({ source: 'merged' }));

    backend.shutdown();
  });

  // t/4187 (client-carried baseSha): readFileWithVersion hands the client the
  // version to send back on its next write. TL design review (t/4187#3)
  // requires content+version to come from the same snapshot, with tests for
  // both arms: the normal atomic case, and the fault arm where they'd disagree.
  describe('readFileWithVersion (t/4187)', () => {
    it('a fresh GitHub fetch returns content and version atomically (cache-miss arm)', async () => {
      const backend = await createBackend();
      const content = JSON.stringify({ hello: 'world' });
      apiHandlers.push((url, init) => {
        if ((init?.method ?? 'GET') === 'GET' && url.includes('/contents/')) {
          return { status: 200, body: { content: Buffer.from(content).toString('base64'), encoding: 'base64', sha: 'sha-fresh' } };
        }
        return null;
      });

      const result = await backend.readFileWithVersion('/taxonomy/nodes.json');

      expect(result).toEqual({ content, version: 'sha-fresh' });
      backend.shutdown();
    });

    it('fault arm: a torn cache read (disk content whose hash does not match its own manifest SHA) is never returned as an atomic pair — forces a fresh fetch instead of a silent stale save', async () => {
      const backend = await createBackend();
      const fsPromises = await import('fs/promises');
      const mockReadFile = vi.mocked(fsPromises.default.readFile);

      // Prime the manifest with a REAL git blob SHA for some known content, so
      // the "good" path is reachable at all (test shas elsewhere in this file
      // are fabricated strings, which would never pass a real hash check).
      const crypto = await import('crypto');
      const realContent = JSON.stringify({ v: 'current' });
      const buf = Buffer.from(realContent, 'utf-8');
      const realSha = crypto.createHash('sha1').update(`blob ${buf.byteLength}\0`).update(buf).digest('hex');

      apiHandlers.push((url, init) => {
        if ((init?.method ?? 'GET') === 'GET' && url.includes('/contents/')) {
          return { status: 200, body: { content: buf.toString('base64'), encoding: 'base64', sha: realSha } };
        }
        return null;
      });
      await backend.readFile('/taxonomy/nodes.json'); // primes manifest.files[...] = { sha: realSha }

      // Now corrupt what the (mocked) disk actually holds — stale content that
      // does NOT hash to the manifest's claimed sha. The manifest itself never
      // moves, so the "entry moved mid-read" guard alone would NOT catch this;
      // only the content-hash check does.
      mockReadFile.mockResolvedValue(Buffer.from(JSON.stringify({ v: 'stale-and-wrong' })));

      // A second GET (the forced fresh fetch) returns the true current state.
      const result = await backend.readFileWithVersion('/taxonomy/nodes.json');

      // Must never be the torn pair (stale content paired with the real sha).
      expect(result).not.toEqual({ content: JSON.stringify({ v: 'stale-and-wrong' }), version: realSha });
      // It resolved to the real, hash-verified state via the forced re-fetch.
      expect(result).toEqual({ content: realContent, version: realSha });

      backend.shutdown();
    });
  });

  // t/4224 (p/775#56, TL): a stale baseSha reaching the actual PUT is the
  // point of the precondition — direct-write mode's own cache-derived SHA
  // must never silently replace the client's baseSha before it's sent.
  it('a stale client baseSha is sent to GitHub unmodified (direct write mode) — the precondition is never silently replaced by the server cache', async () => {
    const backend = await createBackend();
    // No session context → writeFile uses Contents API directly

    let sentSha: string | undefined;
    apiHandlers.push((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'PUT' && url.includes('/contents/')) {
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        sentSha = body?.sha;
        // GitHub itself rejects — this sha is stale relative to its real state.
        return { status: 409, body: { message: 'sha does not match' } };
      }
      return null;
    });

    const staleBaseSha = 'stale-client-sha';
    const err = await backend.writeFile('/taxonomy/nodes.json', '{"v": 2}', { baseSha: staleBaseSha })
      .then(() => null, (e: unknown) => e) as { httpStatus?: number; code?: string } | null;

    expect(err?.httpStatus).toBe(409);
    expect(err?.code).toBe('WRITE_CONFLICT');
    expect(sentSha).toBe(staleBaseSha);

    backend.shutdown();
  });
});

// t/4224 (TL design, p/538#40): getFileSha() ignores `ref` and only ever
// reflects main — the root cause of every write-after-commit/merge/external-
// head-move false conflict this bundle chased. The fix: for a session branch
// with no pending overlay entry, read the current version and edit-load
// content live from GitHub at that branch's ref, on every save and every
// edit-load. Never fall back to main's SHA for a session-branch ref — a
// lookup failure is a 503 ActionableError, not a silent fallback. One
// authoritative source covers commitOverlay, mergeBranch, a resync conflict
// resolved on GitHub, another replica, or anything else that moves the head.
//
// `sessionBranchState(ref)` registers ONE handler per test that serves GET
// .../contents/taxonomy/nodes.json?ref=<branch> from a mutable object — tests
// mutate `.current`/`.sha` to simulate a commit, a merge, or any other
// out-of-band change landing on the branch, and set `.fail = true` to make
// the next lookup fail. Every overlay-fast-path write with no pending overlay
// entry — including the very first one in a session — now makes this live
// call (TL: "one call per save"), so each test registers it before that
// first write, not only after a commit.
// `sessionBranchState(ref)` registers ONE handler per test that serves GET
// .../contents/taxonomy/nodes.json?ref=<branch> from a mutable object — tests
// mutate `.current`/`.sha` to simulate a commit, a merge, or any other
// out-of-band change landing on the branch, and set `.fail = true` to make
// the next lookup fail. `fail` simulates a real fetch failure ('unavailable'
// — 500), distinct from `current === null` ('absent' — 404, a genuinely
// missing file) — collapsing those was the p/538#43 regression.
function sessionBranchState(ref: string): { current: string | null; sha: string | null; fail: boolean } {
  const state = { current: null as string | null, sha: null as string | null, fail: false };
  const refQuery = `ref=${encodeURIComponent(ref)}`;
  apiHandlers.push((url, init) => {
    if ((init?.method ?? 'GET') !== 'GET' || !url.includes('/contents/taxonomy/nodes.json') || !url.includes(refQuery)) {
      return null;
    }
    if (state.fail) return { status: 500, body: { message: 'Internal Server Error' } };
    if (state.current === null || state.sha === null) return { status: 404, body: { message: 'Not Found' } };
    return { status: 200, body: { content: Buffer.from(state.current).toString('base64'), encoding: 'base64', sha: state.sha } };
  });
  return state;
}

function mockCommitSteps(branch: string): void {
  apiHandlers.push((url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.includes(`/git/refs/heads/${branch}`)) {
      return { status: 200, body: { object: { sha: 'branch-head-sha' } } };
    }
    if (method === 'POST' && url.endsWith('/git/trees')) return { status: 201, body: { sha: 'new-tree-sha' } };
    if (method === 'POST' && url.endsWith('/git/commits')) return { status: 201, body: { sha: 'new-commit-sha' } };
    if (method === 'PATCH' && url.includes(`/git/refs/heads/${branch}`)) return { status: 200, body: {} };
    return null;
  });
}

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — session-branch version read live from GitHub (t/4224)', () => {

  it('save, then commit, then save again with the first save\'s returned version — succeeds, no false WRITE_CONFLICT', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    const branch = sessionBranchState('api-session/alice');
    branch.current = '{"test": true}';
    branch.sha = 'blob1';

    const v1 = await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });
    expect(v1.version).toBeTruthy();

    // The commit lands — the branch now holds what was just written.
    branch.current = '{"v": 1}';
    branch.sha = v1.version;
    mockCommitSteps('api-session/alice');
    await backend.commitOverlay('alice', 'test commit');
    expect(backend.getSessionOverlay('alice')).toBeUndefined(); // pending overlay cleared

    const v2 = await backend.writeFile('/taxonomy/nodes.json', '{"v": 2}', { baseSha: v1.version });
    expect(v2.version).toBeTruthy();
    expect(v2.version).not.toBe(v1.version);

    backend.shutdown();
  });

  it('after main changes and a resync merge, a stale save gets WRITE_CONFLICT and an edit load returns the merged content', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    const branch = sessionBranchState('api-session/alice');
    branch.current = '{"test": true}';
    branch.sha = 'blob1';

    const v1 = await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    branch.current = '{"v": 1}';
    branch.sha = v1.version;
    mockCommitSteps('api-session/alice');
    await backend.commitOverlay('alice', 'test commit');

    // main had further, independent changes; the resync auto-merges them in.
    const mergedContent = JSON.stringify({ v: 'merged-from-main' });
    branch.current = mergedContent;
    branch.sha = 'merged-blob-sha';
    apiHandlers.push((url, init) => {
      if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/merges')) return { status: 201, body: { sha: 'merge-commit-sha' } };
      return null;
    });

    const mergeResult = await backend.mergeBranch('api-session/alice');
    expect(mergeResult.ok).toBe(true);

    // A tab that loaded before the resync still carries the pre-merge version.
    const staleErr = await backend.writeFile('/taxonomy/nodes.json', '{"edit": "from a stale tab"}', { baseSha: v1.version })
      .then(() => null, (e: unknown) => e) as { httpStatus?: number; code?: string } | null;
    expect(staleErr?.httpStatus).toBe(409);
    expect(staleErr?.code).toBe('WRITE_CONFLICT');

    // An edit-load reads the branch's real current content, not main's cache.
    const loaded = await backend.readFileWithVersion('/taxonomy/nodes.json');
    expect(loaded).toEqual({ content: mergedContent, version: 'merged-blob-sha' });

    backend.shutdown();
  });

  it('the branch is changed outside the server (no mergeBranch call) — a stale save still gets WRITE_CONFLICT', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    const branch = sessionBranchState('api-session/alice');
    branch.current = '{"test": true}';
    branch.sha = 'blob1';

    const v1 = await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    branch.current = '{"v": 1}';
    branch.sha = v1.version;
    mockCommitSteps('api-session/alice');
    await backend.commitOverlay('alice', 'test commit');

    // No mergeBranch() call at all — simulates a conflict resolved directly on
    // GitHub, another replica's push, or SessionBranchManager.commitBatch.
    // Nothing here is specific to a merge: the branch's content just changed.
    branch.current = JSON.stringify({ v: 'pushed-from-elsewhere' });
    branch.sha = 'external-blob-sha';

    const staleErr = await backend.writeFile('/taxonomy/nodes.json', '{"edit": "from a stale tab"}', { baseSha: v1.version })
      .then(() => null, (e: unknown) => e) as { httpStatus?: number; code?: string } | null;
    expect(staleErr?.httpStatus).toBe(409);
    expect(staleErr?.code).toBe('WRITE_CONFLICT');

    backend.shutdown();
  });

  it('a failed version lookup throws a 503 ActionableError with a WARN, and the save is not staged', async () => {
    const recorder = createTestRecorder();
    const backend = await createBackend(recorder);
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    const branch = sessionBranchState('api-session/alice');
    branch.current = '{"test": true}';
    branch.sha = 'blob1';

    const v1 = await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    branch.current = '{"v": 1}';
    branch.sha = v1.version;
    mockCommitSteps('api-session/alice');
    await backend.commitOverlay('alice', 'test commit');

    // The live lookup can't verify the current version (e.g. a transient
    // GitHub error, or any other fetch failure).
    branch.fail = true;

    const err = await backend.writeFile('/taxonomy/nodes.json', '{"edit": "should not land"}', { baseSha: v1.version })
      .then(() => null, (e: unknown) => e) as { httpStatus?: number; code?: string } | null;

    expect(err?.httpStatus).toBe(503);
    expect(err?.code).toBe('VERSION_UNAVAILABLE');
    // Never staged — the precondition lookup failed before writeToOverlay ran.
    // (the overlay map itself is gone post-commit, so this is undefined, not
    // false — toBeFalsy() covers both rather than over-asserting the shape).
    expect(backend.getSessionOverlay('alice')?.has('taxonomy/nodes.json')).toBeFalsy();
    expect(recorder.events.find(e => e.level === 'warn' && e.message.includes('failing closed'))).toBeDefined();

    backend.shutdown();
  });

  it('ref === baseBranch: readFileWithVersion keeps using the manifest/disk-cache path, unchanged', async () => {
    const backend = await createBackend();
    // No session context — the effective ref is main (the base branch).

    const result = await backend.readFileWithVersion('/taxonomy/nodes.json');

    // Falls through (no overlay) to a fresh GitHub fetch via the unchanged
    // manifest/disk-cache path — not the new session-branch live-fetch helper.
    expect(result).toEqual({ content: '{"test": true}', version: 'blob-sha' });

    backend.shutdown();
  });

  // t/4224 (p/538#43, TL): collapsing 'absent' (404 — a genuinely missing
  // file) into 'unavailable' made every session-branch write that CREATES a
  // path 503. A writer with no baseSha must skip the PRECONDITION check (a
  // 404 here is never the conflict it would be with one). t/4312 (TL's
  // condition 1) adds a *separate* lookup regardless of precondition, to
  // record a base for the commit-time fence — this test now expects exactly
  // one Contents call for that, not zero.
  it('a new path with no baseSha succeeds — skips the precondition check, but t/4312 still does one Contents lookup to record a base for the commit-time fence', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    let contentsLookups = 0;
    apiHandlers.push((url, init) => {
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/contents/')) contentsLookups++;
      return null; // count only — let the default handler still answer
    });

    const result = await backend.writeFile('/taxonomy/new-node.json', '{"new": true}');

    expect(result.version).toBeTruthy();
    expect(contentsLookups).toBe(1);

    backend.shutdown();
  });

  // A baseSha was supplied, so the client expects an existing file — the
  // branch not having one at all is itself the conflict (p/538#43).
  it('a new path with a baseSha gets WRITE_CONFLICT — the client expected a file that does not exist on the branch', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    apiHandlers.push((url, init) => {
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/contents/taxonomy/new-node.json')) {
        return { status: 404, body: { message: 'Not Found' } };
      }
      return null;
    });

    const err = await backend.writeFile('/taxonomy/new-node.json', '{"new": true}', { baseSha: 'client-thinks-this-exists' })
      .then(() => null, (e: unknown) => e) as { httpStatus?: number; code?: string } | null;

    expect(err?.httpStatus).toBe(409);
    expect(err?.code).toBe('WRITE_CONFLICT');

    backend.shutdown();
  });

  // 'absent' must behave like today's missing-file contract for an edit-load
  // — a 503 here would be a regression for any legitimately-new path.
  it('an edit load of a missing path returns null, not a 503', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    apiHandlers.push((url, init) => {
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/contents/taxonomy/new-node.json')) {
        return { status: 404, body: { message: 'Not Found' } };
      }
      return null;
    });

    const result = await backend.readFileWithVersion('/taxonomy/new-node.json');

    expect(result).toBeNull();

    backend.shutdown();
  });
});

// t/4215 (TL design, t/4215#2): a plain readFile() on a session branch, once
// the overlay has no entry for the path, must not fall through to main's
// on-disk cache — commitOverlay clears the overlay, so a read right after a
// commit was returning pre-commit content. Unlike readFileWithVersion's
// always-live read (t/4224), readFile is called from read-modify-write loops
// over many paths (harvest, policy recount, edges), so it uses a per-session
// cache instead: filled for free at commitOverlay/mergeBranch, with the
// branch-head SHA re-verified against the live ref at most once every
// SESSION_READ_CACHE_REVALIDATE_MS so an out-of-band move (a resync conflict
// resolved on GitHub, another replica) is bounded rather than missed. Fails
// closed (503) on an unavailable lookup, same as t/4224 — `null` reads as
// "file doesn't exist" to RMW callers, which would silently rebuild the file
// from empty. `opts.optional` opts a caller into `null` plus a WARN instead.
describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — plain readFile on a session branch (t/4215)', () => {
  it('save, then commit, then a plain readFile sees the committed content', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    const branch = sessionBranchState('api-session/alice');
    branch.current = '{"test": true}';
    branch.sha = 'blob1';

    await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });
    mockCommitSteps('api-session/alice');
    await backend.commitOverlay('alice', 'test commit');

    // Populated for free by commitOverlay — no live Contents call needed.
    const content = await backend.readFile('/taxonomy/nodes.json');
    expect(content).toBe('{"v": 1}');

    backend.shutdown();
  });

  it('a harvest-shaped read-modify-write after a commit keeps the session\'s edit', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    const branch = sessionBranchState('api-session/alice');
    branch.current = '{"test": true}';
    branch.sha = 'blob1';

    const v1 = await backend.writeFile('/taxonomy/nodes.json', '{"count": 1}', { baseSha: 'blob1' });
    mockCommitSteps('api-session/alice');
    await backend.commitOverlay('alice', 'test commit');
    branch.current = '{"count": 1}';
    branch.sha = v1.version;

    // Read current (must see the commit, not main's stale cache), modify,
    // write back — the shape a corrected harvest route follows.
    const current = await backend.readFile('/taxonomy/nodes.json');
    expect(current).toBe('{"count": 1}');

    const modified = JSON.stringify({ count: 2 });
    const v2 = await backend.writeFile('/taxonomy/nodes.json', modified, { baseSha: v1.version });
    expect(v2.version).toBeTruthy();

    backend.shutdown();
  });

  it('two reads of the same path within the revalidation window make only one live Contents lookup (t/4201 invariant)', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    let contentsLookups = 0;
    apiHandlers.push((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/git/refs/heads/api-session/alice')) {
        return { status: 200, body: { object: { sha: 'branch-head-sha' } } };
      }
      if (method === 'GET' && url.includes('/contents/taxonomy/nodes.json')) {
        contentsLookups++;
        return { status: 200, body: { content: Buffer.from('{"v": 1}').toString('base64'), encoding: 'base64', sha: 'live-sha' } };
      }
      return null;
    });

    const first = await backend.readFile('/taxonomy/nodes.json');
    const second = await backend.readFile('/taxonomy/nodes.json');

    expect(first).toBe('{"v": 1}');
    expect(second).toBe('{"v": 1}');
    expect(contentsLookups).toBe(1);

    backend.shutdown();
  });

  it('an out-of-band head change is detected after the revalidation window, for a session that has written something (t/4215 budget addendum)', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    let headSha = 'original-head-sha';
    let liveContent = JSON.stringify({ v: 'original' });
    apiHandlers.push((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/git/refs/heads/api-session/alice')) {
        return { status: 200, body: { object: { sha: headSha } } };
      }
      if (method === 'GET' && url.includes('/contents/taxonomy/nodes.json')) {
        return { status: 200, body: { content: Buffer.from(liveContent).toString('base64'), encoding: 'base64', sha: 'some-sha' } };
      }
      return null;
    });

    const first = await backend.readFile('/taxonomy/nodes.json');
    expect(first).toBe(JSON.stringify({ v: 'original' }));

    // t/4215 budget addendum (TL t/4215#7): a plain read only revalidates if
    // the session has written something since the last check. writeToOverlay
    // (via a write elsewhere) marks this session as active — without this,
    // the ref-check below would never fire at all, by design.
    backend.writeToOverlay('/some/other/path.json', '{}');

    // Something outside the server (a resync conflict resolved on GitHub,
    // another replica) pushes new content onto the branch.
    headSha = 'new-head-sha-from-elsewhere';
    liveContent = JSON.stringify({ v: 'pushed-elsewhere' });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now());

      // Still within the window — the cache is trusted without re-checking.
      const stillCached = await backend.readFile('/taxonomy/nodes.json');
      expect(stillCached).toBe(JSON.stringify({ v: 'original' }));

      // Advance past SESSION_READ_CACHE_REVALIDATE_MS.
      vi.setSystemTime(Date.now() + 31_000);

      const afterWindow = await backend.readFile('/taxonomy/nodes.json');
      expect(afterWindow).toBe(JSON.stringify({ v: 'pushed-elsewhere' }));
    } finally {
      vi.useRealTimers();
    }

    backend.shutdown();
  });

  it('t/4215 budget addendum (TL t/4215#7): an idle (read-only) session re-checks the ref once to seed a baseline, then never again — caps it at 1 per session, well under 1 per 30s', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    let refCalls = 0;
    apiHandlers.push((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/git/refs/heads/api-session/alice')) {
        refCalls++;
        return { status: 200, body: { object: { sha: 'head-sha' } } };
      }
      if (method === 'GET' && url.includes('/contents/taxonomy/nodes.json')) {
        return { status: 200, body: { content: Buffer.from('{"v": 1}').toString('base64'), encoding: 'base64', sha: 'some-sha' } };
      }
      return null;
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now());
      await backend.readFile('/taxonomy/nodes.json'); // first-ever check for this session — no baseline yet, always live

      // Many more reads, spanning many revalidation windows, with NO write
      // activity in between — the session is purely viewing.
      for (let i = 0; i < 5; i++) {
        vi.setSystemTime(Date.now() + 31_000);
        await backend.readFile('/taxonomy/nodes.json');
      }

      // No activity recorded since the baseline was seeded, so every
      // subsequent check trusts the cache — the ref endpoint is called once
      // total, not once per 30s window.
      expect(refCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }

    backend.shutdown();
  });

  it('t/4215 budget addendum (TL t/4215#7): a read that feeds a write (forWrite) always revalidates, ignoring both the throttle and the activity gate', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    let refCalls = 0;
    apiHandlers.push((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/git/refs/heads/api-session/alice')) {
        refCalls++;
        return { status: 200, body: { object: { sha: 'head-sha' } } };
      }
      if (method === 'GET' && url.includes('/contents/taxonomy/nodes.json')) {
        return { status: 200, body: { content: Buffer.from('{"v": 1}').toString('base64'), encoding: 'base64', sha: 'some-sha' } };
      }
      return null;
    });

    // No write activity at all, and both calls happen well inside any
    // throttle window — forWrite must check every time regardless.
    await backend.readFile('/taxonomy/nodes.json', { forWrite: true });
    await backend.readFile('/taxonomy/nodes.json', { forWrite: true });

    expect(refCalls).toBe(2);

    backend.shutdown();
  });

  it('an optional read returns null (plus a WARN) when the lookup is unavailable', async () => {
    const recorder = createTestRecorder();
    const backend = await createBackend(recorder);
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    const branch = sessionBranchState('api-session/alice');
    branch.fail = true;

    const result = await backend.readFile('/taxonomy/nodes.json', { optional: true });

    expect(result).toBeNull();
    expect(recorder.events.find(e => e.level === 'warn' && e.message.includes('optional read'))).toBeDefined();

    backend.shutdown();
  });

  it('a non-optional read throws 503 VERSION_UNAVAILABLE when the lookup is unavailable, and a read-modify-write writes nothing', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    const branch = sessionBranchState('api-session/alice');
    branch.fail = true;

    const err = await backend.readFile('/taxonomy/nodes.json')
      .then(() => null, (e: unknown) => e) as { httpStatus?: number; code?: string } | null;

    expect(err?.httpStatus).toBe(503);
    expect(err?.code).toBe('VERSION_UNAVAILABLE');
    // The read-modify-write never reaches a write — nothing was staged.
    expect(backend.getSessionOverlay('alice')?.has('taxonomy/nodes.json')).toBeFalsy();

    backend.shutdown();
  });
});
