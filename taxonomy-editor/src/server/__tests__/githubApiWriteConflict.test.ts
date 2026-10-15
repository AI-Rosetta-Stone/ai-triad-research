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

async function createSessionManager(backend: Awaited<ReturnType<typeof createBackend>>, recorder?: FlightRecorder) {
  const { SessionBranchManager } = await import('../storage/sessionBranchManager');
  return new SessionBranchManager(backend, recorder ?? createTestRecorder());
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

  // t/4203 (p/775#56, TL): a stale baseSha reaching the actual PUT is the
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

// t/4203 (p/775#56, TL): commitOverlay() clears the pending overlay on
// success, but getFileSha() ignores `ref` and only ever reflects main — so
// without a committed-session baseline, the very next save's precondition
// check compares against main's stale SHA instead of what this session just
// committed, false-conflicting on every save after the first.
describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — committed-session baseline after commitOverlay (t/4203)', () => {
  it('save, then commit, then save again with the first save\'s returned version — succeeds, no false WRITE_CONFLICT', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    // 'blob1' is the repo-tree sha already in place for this path at
    // initialize() (see handleDefaultGithubApi's /git/trees/ response).
    const v1 = await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });
    expect(v1.version).toBeTruthy();

    apiHandlers.push((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/git/refs/heads/api-session/alice')) {
        return { status: 200, body: { object: { sha: 'branch-head-sha' } } };
      }
      if (method === 'POST' && url.endsWith('/git/trees')) return { status: 201, body: { sha: 'new-tree-sha' } };
      if (method === 'POST' && url.endsWith('/git/commits')) return { status: 201, body: { sha: 'new-commit-sha' } };
      if (method === 'PATCH' && url.includes('/git/refs/heads/api-session/alice')) return { status: 200, body: {} };
      return null;
    });

    const commitResult = await backend.commitOverlay('alice', 'test commit');
    expect(commitResult).not.toBeNull();
    expect(backend.getSessionOverlay('alice')).toBeUndefined(); // pending overlay cleared

    // The regression this guards: without the committed-baseline fallback,
    // this save's precondition check falls through to getFileSha(), which
    // ignores `ref` and returns main's stale 'blob1' — not v1.version — so a
    // real client's next save (correctly carrying v1.version as its baseSha)
    // would false-conflict here.
    const v2 = await backend.writeFile('/taxonomy/nodes.json', '{"v": 2}', { baseSha: v1.version });
    expect(v2.version).toBeTruthy();
    expect(v2.version).not.toBe(v1.version);
    expect(backend.getSessionOverlay('alice')?.get('taxonomy/nodes.json')).toBe('{"v": 2}');

    backend.shutdown();
  });
});

// t/4203 (TL probe, p/775#64): mergeBranch() moves the session branch HEAD
// independently of commitOverlay — without a refresh, the committed-session
// baseline from an earlier commit outlives a resync merge, so a stale tab's
// save can pass its precondition against pre-merge content and the next
// commit silently erases whatever the merge brought in from main.
describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — committed-session baseline survives a resync merge (t/4203)', () => {
  it('a resync refreshes the baseline — a stale save then conflicts, and a save against the merged content succeeds', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    const v1 = await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    apiHandlers.push((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/git/refs/heads/api-session/alice')) {
        return { status: 200, body: { object: { sha: 'branch-head-sha' } } };
      }
      if (method === 'POST' && url.endsWith('/git/trees')) return { status: 201, body: { sha: 'new-tree-sha' } };
      if (method === 'POST' && url.endsWith('/git/commits')) return { status: 201, body: { sha: 'new-commit-sha' } };
      if (method === 'PATCH' && url.includes('/git/refs/heads/api-session/alice')) return { status: 200, body: {} };
      return null;
    });
    await backend.commitOverlay('alice', 'test commit');
    expect(backend.getCommittedOverlayBaseline('alice')?.get('taxonomy/nodes.json')).toBe('{"v": 1}');

    // Simulate a resync: main had further, independent changes to this same
    // path, auto-merged into the session branch by GitHub's Merges API.
    const mergedContent = JSON.stringify({ v: 'merged-from-main' });
    apiHandlers.push((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.endsWith('/merges')) return { status: 201, body: { sha: 'merge-commit-sha' } };
      if (method === 'GET' && url.includes('/contents/taxonomy/nodes.json') && url.includes('ref=api-session%2Falice')) {
        return { status: 200, body: { content: Buffer.from(mergedContent).toString('base64'), encoding: 'base64', sha: 'merged-blob-sha' } };
      }
      return null;
    });

    const mergeResult = await backend.mergeBranch('api-session/alice');
    expect(mergeResult.ok).toBe(true);
    // The refresh replaced the pre-merge baseline with the merge's real content.
    expect(backend.getCommittedOverlayBaseline('alice')?.get('taxonomy/nodes.json')).toBe(mergedContent);

    // A tab that loaded before the resync still carries the pre-merge version.
    const staleErr = await backend.writeFile('/taxonomy/nodes.json', '{"edit": "from a stale tab"}', { baseSha: v1.version })
      .then(() => null, (e: unknown) => e) as { httpStatus?: number; code?: string } | null;
    expect(staleErr?.httpStatus).toBe(409);
    expect(staleErr?.code).toBe('WRITE_CONFLICT');

    // A save against the merged content's own version succeeds, and does not
    // silently clobber what the merge brought in.
    const v2 = await backend.writeFile('/taxonomy/nodes.json', '{"edit": "after reload"}', { baseSha: gitBlobSha(mergedContent) });
    expect(v2.version).toBeTruthy();

    backend.shutdown();
  });

  it('a path whose refresh fails is evicted from the baseline (fails closed) rather than kept stale', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    apiHandlers.push((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/git/refs/heads/api-session/alice')) {
        return { status: 200, body: { object: { sha: 'branch-head-sha' } } };
      }
      if (method === 'POST' && url.endsWith('/git/trees')) return { status: 201, body: { sha: 'new-tree-sha' } };
      if (method === 'POST' && url.endsWith('/git/commits')) return { status: 201, body: { sha: 'new-commit-sha' } };
      if (method === 'PATCH' && url.includes('/git/refs/heads/api-session/alice')) return { status: 200, body: {} };
      return null;
    });
    await backend.commitOverlay('alice', 'test commit');

    // The merge "succeeds" on GitHub, but re-fetching this path from the
    // branch's new HEAD fails (e.g. the merge deleted it) — the refresh must
    // not just keep serving the pre-merge content as if it were still current.
    apiHandlers.push((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.endsWith('/merges')) return { status: 201, body: { sha: 'merge-commit-sha' } };
      if (method === 'GET' && url.includes('/contents/taxonomy/nodes.json')) return { status: 404, body: { message: 'Not Found' } };
      return null;
    });

    await backend.mergeBranch('api-session/alice');
    expect(backend.getCommittedOverlayBaseline('alice')?.has('taxonomy/nodes.json')).toBe(false);

    backend.shutdown();
  });
});

// t/4203 (TL "N3", p/775#64): deleteBranch clears the committed-session
// baseline alongside the pending overlay — previously wired with no test to
// catch a regression.
describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — deleteBranch clears the committed-session baseline (t/4203)', () => {
  it('after deleteBranch, the committed baseline for that user is gone', async () => {
    const backend = await createBackend();
    const manager = await createSessionManager(backend);
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    await manager.ensureBranch('alice');
    await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    apiHandlers.push((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/git/refs/heads/api-session/alice')) {
        return { status: 200, body: { object: { sha: 'branch-head-sha' } } };
      }
      if (method === 'POST' && url.endsWith('/git/trees')) return { status: 201, body: { sha: 'new-tree-sha' } };
      if (method === 'POST' && url.endsWith('/git/commits')) return { status: 201, body: { sha: 'new-commit-sha' } };
      if (method === 'PATCH' && url.includes('/git/refs/heads/api-session/alice')) return { status: 200, body: {} };
      return null;
    });
    await backend.commitOverlay('alice', 'test commit');
    expect(backend.getCommittedOverlayBaseline('alice')?.size).toBe(1);

    await manager.deleteBranch('alice', 'manual');

    expect(backend.getCommittedOverlayBaseline('alice')).toBeUndefined();

    backend.shutdown();
  });
});
