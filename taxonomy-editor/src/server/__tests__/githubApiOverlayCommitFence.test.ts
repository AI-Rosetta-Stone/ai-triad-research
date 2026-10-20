// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4312 (TL p/538#89/#91): a 422-only check misses the common case — if A
 * commits X first and succeeds, B's commit *starts* afterward, reads the new
 * head (already containing A's X), and its PATCH succeeds as a valid
 * fast-forward (B's commit's parent is literally the current ref). No 422
 * ever fires, yet B's stale X would silently overwrite A's. The fix: a
 * per-path base blob sha recorded at first staging, checked on every commit
 * attempt (not just after a 422) against a fresh tree fetch.
 *
 * Simulates two replicas as two independent GitHubAPIBackend instances
 * sharing one mocked GitHub remote (a single-branch content map + sha
 * derived via the real gitBlobSha, so the Contents API and Trees API mocks
 * stay consistent with each other and with the app's own version-reporting).
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

// ── A minimal, single-branch simulated GitHub remote, shared across backend
// instances via module-level state reset in beforeEach. Content is the
// source of truth; shas are derived on demand via the real gitBlobSha so the
// Contents API and Trees API mocks can never disagree with each other. ──
let contentByPath: Map<string, string>;
let branchSha: string;
let commitCounter: number;
let lastPostedTreeOps: { path: string; content: string | null }[] | null;

function resetRemote(initial: Record<string, string>): void {
  contentByPath = new Map(Object.entries(initial));
  branchSha = 'base-0000000000000000000000000000000000dead';
  commitCounter = 0;
  lastPostedTreeOps = null;
}

function handleRemote(url: string, init: RequestInit): { status: number; body: unknown } {
  const method = (init?.method ?? 'GET');
  const path = url.replace('https://api.github.com', '');
  if (method === 'GET' && /\/git\/refs\/heads\//.test(path)) {
    return { status: 200, body: { object: { sha: branchSha } } };
  }
  if (method === 'GET' && /\/git\/trees\/[^/]+\?recursive=1/.test(path)) {
    return {
      status: 200,
      body: {
        sha: branchSha, truncated: false,
        tree: [...contentByPath.entries()].map(([p, c]) => ({ path: p, sha: gitBlobSha(c), type: 'blob', mode: '100644' })),
      },
    };
  }
  if (method === 'GET' && path.includes('/contents/')) {
    const repoPath = decodeURIComponent(path.split('/contents/')[1].split('?')[0]);
    const content = contentByPath.get(repoPath);
    if (content === undefined) return { status: 404, body: { message: 'Not Found' } };
    return { status: 200, body: { content: Buffer.from(content).toString('base64'), encoding: 'base64', sha: gitBlobSha(content) } };
  }
  if (method === 'POST' && path.endsWith('/git/trees')) {
    const body = JSON.parse(init.body as string) as { tree: { path: string; sha?: string | null; content?: string }[] };
    lastPostedTreeOps = body.tree.map(e => ({ path: e.path, content: e.sha === null ? null : (e.content ?? null) }));
    return { status: 201, body: { sha: `tree-${++commitCounter}` } };
  }
  if (method === 'POST' && path.endsWith('/git/commits')) {
    return { status: 201, body: { sha: `commit-${++commitCounter}` } };
  }
  if (method === 'PATCH' && /\/git\/refs\/heads\//.test(path)) {
    for (const op of lastPostedTreeOps ?? []) {
      if (op.content === null) contentByPath.delete(op.path); else contentByPath.set(op.path, op.content);
    }
    branchSha = `commit-${commitCounter}`;
    return { status: 200, body: { object: { sha: branchSha } } };
  }
  return { status: 404, body: { message: 'Not Found' } };
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  resetRemote({ 'taxonomy/nodes.json': '{"v":0}' });
  vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test');
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const result = handleRemote(url, init ?? {});
    return mockFetchResponse(result.status, result.body);
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

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — t/4312 overlay commit base fence', () => {
  it('TL scenario: no 422 ever fires, but a sequential overwrite is still caught', async () => {
    const backendA = await createBackend();
    const backendB = await createBackend();
    backendA.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    backendB.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    const base = gitBlobSha('{"v":0}');
    await backendA.writeFile('/taxonomy/nodes.json', '{"v":"A"}', { baseSha: base });
    await backendB.writeFile('/taxonomy/nodes.json', '{"v":"B-stale"}', { baseSha: base });

    const resultA = await backendA.commitOverlay('alice', undefined, { branchName: 'api-session/alice' });
    expect(resultA?.filesCommitted).toBe(1);
    expect(contentByPath.get('taxonomy/nodes.json')).toBe('{"v":"A"}');

    // B's commit starts AFTER A's succeeded — reads the new head (A's), and
    // its own PATCH would succeed as a fast-forward (no 422). Assert the
    // per-path base check still excludes B's stale write from the tree.
    const resultB = await backendB.commitOverlay('alice', undefined, { branchName: 'api-session/alice' });

    expect(contentByPath.get('taxonomy/nodes.json')).toBe('{"v":"A"}'); // not overwritten
    expect(resultB?.filesCommitted).toBe(0);
    expect(resultB?.conflictedPaths).toEqual(['taxonomy/nodes.json']);
    expect(backendB.getSessionOverlay('alice')?.get('taxonomy/nodes.json')).toBe('{"v":"B-stale"}'); // stays staged

    backendA.shutdown(); backendB.shutdown();
  });

  it('non-overlapping paths still commit cleanly together (regression guard)', async () => {
    contentByPath.set('taxonomy/other.json', '{"other":true}');
    const backendA = await createBackend();
    const backendB = await createBackend();
    backendA.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    backendB.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    await backendA.writeFile('/taxonomy/nodes.json', '{"v":"A"}', { baseSha: gitBlobSha('{"v":0}') });
    await backendB.writeFile('/taxonomy/other.json', '{"other":"B"}', { baseSha: gitBlobSha('{"other":true}') });

    const resultA = await backendA.commitOverlay('alice', undefined, { branchName: 'api-session/alice' });
    expect(resultA?.filesCommitted).toBe(1);

    const resultB = await backendB.commitOverlay('alice', undefined, { branchName: 'api-session/alice' });
    expect(resultB?.filesCommitted).toBe(1);
    expect(resultB?.conflictedPaths).toBeUndefined();
    expect(contentByPath.get('taxonomy/nodes.json')).toBe('{"v":"A"}');
    expect(contentByPath.get('taxonomy/other.json')).toBe('{"other":"B"}');

    backendA.shutdown(); backendB.shutdown();
  });

  it('a user never conflicts with themselves: a mid-flight edit survives a partial clear with its base refreshed', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    await backend.writeFile('/taxonomy/nodes.json', '{"v":"first"}', { baseSha: gitBlobSha('{"v":0}') });

    // Simulate a mid-flight edit landing between the commit's base-fetch and
    // its post-commit cleanup, by writing again right after kicking off the
    // commit (before it settles) — same race clearCommittedOverlayEntries
    // (t/4277 C1) already guards against; this proves t/4312's base refresh
    // works the same way for the base-sha side of that guard.
    const commitPromise = backend.commitOverlay('alice', undefined, { branchName: 'api-session/alice' });
    await backend.writeFile('/taxonomy/nodes.json', '{"v":"mid-flight"}'); // no baseSha — direct overlay rewrite
    const result = await commitPromise;

    expect(result?.filesCommitted).toBe(1);
    expect(contentByPath.get('taxonomy/nodes.json')).toBe('{"v":"first"}'); // what actually committed
    expect(backend.getSessionOverlay('alice')?.get('taxonomy/nodes.json')).toBe('{"v":"mid-flight"}'); // stays staged

    // The next commit attempt must NOT treat this as a conflict with itself —
    // its base should have been refreshed to what was just committed.
    const result2 = await backend.commitOverlay('alice', undefined, { branchName: 'api-session/alice' });
    expect(result2?.conflictedPaths).toBeUndefined();
    expect(result2?.filesCommitted).toBe(1);
    expect(contentByPath.get('taxonomy/nodes.json')).toBe('{"v":"mid-flight"}');

    backend.shutdown();
  });

  it('fails closed when the base-tree lookup is truncated', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    await backend.writeFile('/taxonomy/nodes.json', '{"v":"A"}', { baseSha: gitBlobSha('{"v":0}') });

    const realHandle = handleRemote;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (method === 'GET' && /\/git\/trees\/[^/]+\?recursive=1/.test(url)) {
        return mockFetchResponse(200, { sha: branchSha, truncated: true, tree: [] });
      }
      const result = realHandle(url, init ?? {});
      return mockFetchResponse(result.status, result.body);
    }) as unknown as typeof fetch;

    const result = await backend.commitOverlay('alice', undefined, { branchName: 'api-session/alice' });
    expect(result?.filesCommitted).toBe(0);
    expect(result?.conflictedPaths).toEqual(['taxonomy/nodes.json']);
    expect(contentByPath.get('taxonomy/nodes.json')).toBe('{"v":0}'); // untouched

    backend.shutdown();
  });

  it('deletes get the same base-sha fencing as writes', async () => {
    const backendA = await createBackend();
    const backendB = await createBackend();
    backendA.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    backendB.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    await backendA.writeFile('/taxonomy/nodes.json', '{"v":"A"}', { baseSha: gitBlobSha('{"v":0}') });
    await backendB.deleteFile('/taxonomy/nodes.json');

    const resultA = await backendA.commitOverlay('alice', undefined, { branchName: 'api-session/alice' });
    expect(resultA?.filesCommitted).toBe(1);
    expect(contentByPath.has('taxonomy/nodes.json')).toBe(true);

    // B's delete was staged against the OLD content — must not delete A's new write.
    const resultB = await backendB.commitOverlay('alice', undefined, { branchName: 'api-session/alice' });
    expect(resultB?.filesCommitted).toBe(0);
    expect(resultB?.conflictedPaths).toEqual(['taxonomy/nodes.json']);
    expect(contentByPath.get('taxonomy/nodes.json')).toBe('{"v":"A"}'); // not deleted

    backendA.shutdown(); backendB.shutdown();
  });

  // SO F1 (e/333#2), TL p/538#94/#97, Rosetta Stone's catch (p/641#10/#11):
  // both resolution actions operate on the WHOLE staged batch, never a
  // per-path subset — a per-path "Use theirs" that discarded only the
  // conflicting path while leaving an unrelated staged path untouched would
  // reintroduce exactly the cross-file inconsistency F2 (all-or-nothing)
  // exists to prevent.
  describe('resolution contract (SO F1): whole-batch, not per-path', () => {
    it('"Use theirs" discards the ENTIRE staged batch, including paths that did not conflict', async () => {
      const backendA = await createBackend();
      const backendB = await createBackend();
      backendA.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
      backendB.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

      await backendA.writeFile('/taxonomy/nodes.json', '{"v":"A"}', { baseSha: gitBlobSha('{"v":0}') });
      await backendB.writeFile('/taxonomy/nodes.json', '{"v":"B-stale"}', { baseSha: gitBlobSha('{"v":0}') });
      await backendB.writeFile('/taxonomy/unrelated.json', '{"u":"B"}'); // staged, never conflicts itself

      await backendA.commitOverlay('alice', undefined, { branchName: 'api-session/alice' });
      const resultB = await backendB.commitOverlay('alice', undefined, { branchName: 'api-session/alice' });
      expect(resultB?.conflictedPaths).toEqual(['taxonomy/nodes.json']); // only this path actually conflicted
      expect(backendB.getSessionOverlay('alice')?.has('taxonomy/unrelated.json')).toBe(true); // still staged

      const discarded = backendB.discardConflictedOverlayEntries('alice');
      expect(discarded.sort()).toEqual(['taxonomy/nodes.json', 'taxonomy/unrelated.json']); // BOTH, not just the conflicting one
      expect(backendB.getSessionOverlay('alice')).toBeUndefined(); // whole batch gone

      backendA.shutdown(); backendB.shutdown();
    });

    it('"Keep mine" re-bases and commits the ENTIRE staged batch, including paths that did not conflict', async () => {
      contentByPath.set('taxonomy/unrelated.json', '{"u":"orig"}');
      const backendA = await createBackend();
      const backendB = await createBackend();
      backendA.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
      backendB.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

      await backendA.writeFile('/taxonomy/nodes.json', '{"v":"A"}', { baseSha: gitBlobSha('{"v":0}') });
      await backendB.writeFile('/taxonomy/nodes.json', '{"v":"B-stale"}', { baseSha: gitBlobSha('{"v":0}') });
      await backendB.writeFile('/taxonomy/unrelated.json', '{"u":"B"}', { baseSha: gitBlobSha('{"u":"orig"}') });

      await backendA.commitOverlay('alice', undefined, { branchName: 'api-session/alice' });
      const resultB = await backendB.commitOverlay('alice', undefined, { branchName: 'api-session/alice' });
      expect(resultB?.conflictedPaths).toEqual(['taxonomy/nodes.json']);

      const resolved = await backendB.rebaseAndRecommitConflictedOverlayEntries('alice', 'api-session/alice');
      expect(resolved.committed).toBe(true);
      expect(resolved.stillConflicted).toEqual([]);
      expect(resolved.filesCommitted).toBe(2); // both paths committed together, not just the conflicting one
      expect(contentByPath.get('taxonomy/nodes.json')).toBe('{"v":"B-stale"}'); // B's explicit overwrite
      expect(contentByPath.get('taxonomy/unrelated.json')).toBe('{"u":"B"}');
      expect(backendB.getSessionOverlay('alice')).toBeUndefined();

      backendA.shutdown(); backendB.shutdown();
    });

    it('both resolution methods are no-ops when nothing is staged', async () => {
      const backend = await createBackend();
      backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

      expect(backend.discardConflictedOverlayEntries('alice')).toEqual([]);
      const resolved = await backend.rebaseAndRecommitConflictedOverlayEntries('alice', 'api-session/alice');
      expect(resolved).toEqual({ committed: false, stillConflicted: [] });

      backend.shutdown();
    });
  });
});
