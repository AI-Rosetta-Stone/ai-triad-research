// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * Integration + chaos tests for the GitHub API-first backend.
 *
 * Tests GitHubAPIBackend and SessionBranchManager against mocked GitHub APIs
 * to validate: session lifecycle, batch commits, PR creation, cache behavior,
 * circuit breaker, rate limit handling, and concurrent mutation safety.
 *
 * LOCAL-ONLY FAILURE MODE (t/2281): if these tests fail with "undici major-version skew",
 * your local Node is outside the required range (package.json engines: ">=22 <23").
 * CI uses node:22.23.2 (Dockerfile) which bundles undici 6.x matching the userland pin.
 * Fix: switch to Node 22.x via nvm/fnm. This is not a test or code defect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from 'undici';
import { assertUndiciMajorInvariant, isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';
import type { FlightRecorder, RecordInput } from '../../../../lib/flight-recorder/index';

// t/3444: every describe below that constructs a GitHubAPIBackend/SessionBranchManager
// is gated on this — on a local Node whose bundled undici major skews from the userland
// pin, GitHubRestClient's constructor throws deterministically (assertUndiciMajorInvariant),
// masking real local failures behind 75 always-red tests. CI's Dockerfile pins node:22.23.2
// so these always run there. `sanitizeBranchName` and `assertUndiciMajorInvariant` below
// test pure functions with no backend construction — they stay ungated.
const UNDICI_ALIGNED = isUndiciMajorAlignedWithRuntime();

// ── Mock setup ──────────────────────────────────────────────────────────

// Mock fs/promises — prevent real disk I/O
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

// persistence.ts does `import fs from 'fs'` then calls `fs.promises.rename` (the
// `.promises` property on the *fs* module — distinct from the `fs/promises`
// module mocked above). saveManifest's atomic write goes through the mocked
// `fs/promises` (no-op), so the real rename would ENOENT on a temp file that was
// never written. Stub only fs.promises.rename to a resolved no-op — preserve all
// other (real) fs behavior — to match the fs/promises mock's intent.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const src = (actual.default ?? actual) as Record<string, unknown>;
  const patched = {
    ...src,
    promises: { ...(src.promises as object), rename: vi.fn().mockResolvedValue(undefined) },
  };
  return { ...patched, default: patched };
});

// Mock githubAppAuth — provide predictable test credentials
vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({
    repo: 'testowner/testrepo',
    token: 'test-token-abc123',
    mode: 'pat' as const,
  }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getTokenExpiryMs: vi.fn().mockReturnValue(0), // PAT mode — no expiry
}));

// Mock flight recorder — prevent ReferenceError in catch blocks
vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: vi.fn().mockReturnValue(null),
  FlightRecorder: vi.fn(),
}));

// Track fetch calls for assertions
const fetchCalls: Array<{ url: string; method: string; body?: unknown }> = [];

// Default GitHub API response handlers — keyed by (method, urlPattern)
type MockHandler = (url: string, init: RequestInit) => {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
};

let apiHandlers: MockHandler[] = [];
const defaultRateLimitHeaders = {
  'x-ratelimit-remaining': '4999',
  'x-ratelimit-limit': '5000',
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
};

function mockFetchResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const allHeaders = { ...defaultRateLimitHeaders, ...headers };
  return new Response(
    status === 204 ? null : JSON.stringify(body),
    {
      status,
      headers: new Headers(allHeaders),
    },
  );
}

// Install global fetch mock
const originalFetch = globalThis.fetch;
beforeEach(() => {
  fetchCalls.length = 0;
  apiHandlers = [];
  // Align getDataRoot() with createBackend()'s cacheDir so toRepoPath() strips the
  // right prefix. Tests that need a divergent dataRoot override this in their own beforeEach.
  vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test');

  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    fetchCalls.push({ url, method, body });

    // Try custom handlers first
    for (const handler of apiHandlers) {
      const result = handler(url, init ?? {});
      if (result) return mockFetchResponse(result.status, result.body, result.headers);
    }

    // Default handler based on URL pattern
    return handleDefaultGithubApi(url, method, body);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ── Default GitHub API mock ──────────────────────────────────────────────

const MAIN_SHA = 'abc123def456789000000000000000000000dead';
const TREE_SHA = 'tree-sha-000000000000000000000000000dead';
const COMMIT_SHA = 'commit-sha-00000000000000000000000000dead';

function handleDefaultGithubApi(url: string, method: string, body?: unknown): Response {
  const path = url.replace('https://api.github.com', '');

  // GET /repos/:owner/:repo/commits/main
  if (method === 'GET' && path.includes('/commits/main')) {
    return mockFetchResponse(200, { sha: MAIN_SHA });
  }

  // GET /repos/:owner/:repo/git/commits/:sha — fetch commit for tree SHA
  if (method === 'GET' && path.match(/\/git\/commits\/[a-f0-9]/)) {
    return mockFetchResponse(200, { sha: MAIN_SHA, tree: { sha: TREE_SHA } });
  }

  // GET /repos/:owner/:repo/git/trees/:sha?recursive=1
  if (method === 'GET' && path.includes('/git/trees/')) {
    return mockFetchResponse(200, {
      sha: TREE_SHA,
      truncated: false,
      tree: [
        { path: 'taxonomy/nodes.json', mode: '100644', type: 'blob', sha: 'blob1', size: 100 },
        { path: 'taxonomy/edges.json', mode: '100644', type: 'blob', sha: 'blob2', size: 50 },
        { path: 'sources/index.json', mode: '100644', type: 'blob', sha: 'blob3', size: 200 },
      ],
    });
  }

  // POST /repos/:owner/:repo/git/refs — create branch
  if (method === 'POST' && path.includes('/git/refs') && !path.includes('/heads/')) {
    return mockFetchResponse(201, {
      ref: `refs/heads/${(body as { ref: string })?.ref?.replace('refs/heads/', '')}`,
      object: { sha: MAIN_SHA },
    });
  }

  // GET /repos/:owner/:repo/git/refs/heads/:branch — branch exists check
  if (method === 'GET' && path.includes('/git/refs/heads/')) {
    return mockFetchResponse(200, {
      ref: path.split('/git/refs/')[1],
      object: { sha: MAIN_SHA },
    });
  }

  // POST /repos/:owner/:repo/git/trees — create tree
  if (method === 'POST' && path.endsWith('/git/trees')) {
    return mockFetchResponse(201, { sha: TREE_SHA });
  }

  // POST /repos/:owner/:repo/git/commits — create commit
  if (method === 'POST' && path.endsWith('/git/commits')) {
    return mockFetchResponse(201, { sha: COMMIT_SHA });
  }

  // PATCH /repos/:owner/:repo/git/refs/heads/:branch — update ref
  if (method === 'PATCH' && path.includes('/git/refs/heads/')) {
    return mockFetchResponse(200, { object: { sha: COMMIT_SHA } });
  }

  // GET /repos/:owner/:repo/pulls?... — list PRs
  if (method === 'GET' && path.includes('/pulls?')) {
    return mockFetchResponse(200, []);
  }

  // POST /repos/:owner/:repo/pulls — create PR
  if (method === 'POST' && path.endsWith('/pulls')) {
    return mockFetchResponse(201, {
      number: 42,
      html_url: 'https://github.com/testowner/testrepo/pull/42',
    });
  }

  // PATCH /repos/:owner/:repo/pulls/:number — update PR
  if (method === 'PATCH' && path.match(/\/pulls\/\d+$/)) {
    return mockFetchResponse(200, {});
  }

  // GET /repos/:owner/:repo/compare/... — compare branches
  if (method === 'GET' && path.includes('/compare/')) {
    return mockFetchResponse(200, {
      ahead_by: 3,
      behind_by: 1,
      status: 'ahead',
      files: [
        { filename: 'taxonomy/nodes.json', status: 'modified', patch: '@@ -1 +1 @@' },
      ],
      total_commits: 3,
    });
  }

  // POST /repos/:owner/:repo/merges — merge branches
  if (method === 'POST' && path.endsWith('/merges')) {
    return mockFetchResponse(201, { sha: COMMIT_SHA });
  }

  // PUT /repos/:owner/:repo/contents/:path — write file
  if (method === 'PUT' && path.includes('/contents/')) {
    return mockFetchResponse(200, { content: { sha: 'new-blob-sha' } });
  }

  // GET /repos/:owner/:repo/contents/:path — read file
  if (method === 'GET' && path.includes('/contents/')) {
    return mockFetchResponse(200, {
      content: Buffer.from('{"test": true}').toString('base64'),
      encoding: 'base64',
      sha: 'blob-sha',
    });
  }

  // DELETE /repos/:owner/:repo/git/refs/heads/:branch — delete branch
  if (method === 'DELETE' && path.includes('/git/refs/heads/')) {
    return mockFetchResponse(204, null);
  }

  // Fallback
  return mockFetchResponse(404, { message: 'Not Found' });
}

// ── Test recorder ────────────────────────────────────────────────────────

function createTestRecorder(): FlightRecorder & { events: RecordInput[] } {
  const events: RecordInput[] = [];
  return {
    events,
    record: (input: RecordInput) => { events.push(input); },
    flush: vi.fn(),
    toJSON: vi.fn().mockReturnValue([]),
    intern: vi.fn(),
  } as unknown as FlightRecorder & { events: RecordInput[] };
}

// ── Lazy imports (after mocks) ──────────────────────────────────────────

async function createBackend(recorder?: FlightRecorder) {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const backend = new GitHubAPIBackend({
    cacheDir: '/var/cache/taxonomy-test', // non-tmpdir: breaks CodeQL /tmp taint flow (t/2020)
    recorder: recorder ?? createTestRecorder(),
    pollIntervalMs: 999_999_999, // disable polling in tests
    coherencyProbeRate: 0,        // disable coherency probes
  });
  await backend.initialize();
  return backend;
}

async function createSessionManager(backend?: Awaited<ReturnType<typeof createBackend>>, recorder?: FlightRecorder) {
  const { SessionBranchManager } = await import('../storage/sessionBranchManager');
  const rec = recorder ?? createTestRecorder();
  const be = backend ?? await createBackend(rec);
  return { manager: new SessionBranchManager(be, rec), backend: be, recorder: rec };
}

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — integration', () => {
  it('initializes and fetches the repo tree', async () => {
    const recorder = createTestRecorder();
    const backend = await createBackend(recorder);

    expect(backend.getMainSha()).toBe(MAIN_SHA);
    expect(backend.getCircuitState()).toBe('closed');
    expect(backend.getRateLimitRemaining()).toBeGreaterThan(0);

    backend.shutdown();
  });

  it('reads a file from GitHub on cache miss', async () => {
    const backend = await createBackend();

    // fetchFileFromGitHub is called internally; it uses Contents API
    const content = await backend.readFile('/taxonomy/nodes.json');
    // Our mock returns base64-encoded '{"test": true}'
    expect(content).toBe('{"test": true}');

    backend.shutdown();
  });

  it('writes to overlay only when session branch is active (no API call)', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    await backend.writeFile('/taxonomy/nodes.json', '{"updated": true}');

    // Session overlay should contain the written content
    const overlay = backend.getSessionOverlay('alice');
    expect(overlay?.get('taxonomy/nodes.json')).toBe('{"updated": true}');

    // No PUT call to Contents API — overlay-only write
    const putCall = fetchCalls.find(c => c.method === 'PUT' && c.url.includes('/contents/'));
    expect(putCall).toBeUndefined();

    backend.shutdown();
  });

  it('rejects writes to main when session context is set', async () => {
    const backend = await createBackend();
    // Session context with no branch name → reads from main, writes blocked
    backend.setSessionContext({ userId: 'alice' });

    await expect(backend.writeFile('/taxonomy/nodes.json', '{}')).rejects.toThrow(
      /Cannot write directly to main/,
    );

    backend.shutdown();
  });

  it('retries once on 409 SHA conflict with fresh SHA (direct write mode)', async () => {
    const recorder = createTestRecorder();
    const backend = await createBackend(recorder);
    // No session context → writeFile uses Contents API directly

    let putCount = 0;
    apiHandlers.push((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'PUT' && url.includes('/contents/')) {
        putCount++;
        if (putCount === 1) {
          // First PUT → 409 conflict
          return { status: 409, body: { message: 'sha does not match' } };
        }
        // Second PUT → success
        return { status: 200, body: { content: { sha: 'new-blob-sha-retry' } } };
      }
      return null!;
    });

    await backend.writeFile('/taxonomy/nodes.json', '{"retry": true}');

    expect(putCount).toBe(2);
    // Verify flight recorder logged the conflict
    const conflictEvent = recorder.events.find(e => e.type === 'github.api.conflict');
    expect(conflictEvent).toBeDefined();
    expect(conflictEvent!.data).toMatchObject({ path: 'taxonomy/nodes.json' });

    backend.shutdown();
  });

  it('throws on second 409 (no infinite retry, direct write mode)', async () => {
    const backend = await createBackend();
    // No session context → writeFile uses Contents API directly

    apiHandlers.push((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'PUT' && url.includes('/contents/')) {
        return { status: 409, body: { message: 'sha does not match' } };
      }
      return null!;
    });

    await expect(backend.writeFile('/taxonomy/nodes.json', '{}')).rejects.toThrow(/409/);

    backend.shutdown();
  });

  it('rejects path traversal attempts', async () => {
    const backend = await createBackend();

    await expect(backend.readFile('/../../../etc/passwd')).rejects.toThrow(/path traversal/i);
    await expect(backend.readFile('/.git/config')).rejects.toThrow(/.git directory rejected/i);

    backend.shutdown();
  });

  it('creates a branch from main HEAD', async () => {
    const backend = await createBackend();

    await backend.createBranch('api-session/test-user');

    const createCall = fetchCalls.find(c =>
      c.method === 'POST' && c.url.includes('/git/refs'),
    );
    expect(createCall).toBeDefined();
    expect(createCall!.body).toEqual({
      ref: 'refs/heads/api-session/test-user',
      sha: MAIN_SHA,
    });

    backend.shutdown();
  });

  it('performs a 4-step batch commit via Trees API', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    const sha = await backend.createCommitFromTree(
      'api-session/alice',
      [{ path: 'taxonomy/nodes.json', content: '{"v":2}' }],
      'Test commit',
    );

    expect(sha).toBe(COMMIT_SHA);

    // Verify all 4 steps: GET ref, POST tree, POST commit, PATCH ref
    const apiCalls = fetchCalls.filter(c =>
      c.url.includes('/git/') &&
      !c.url.includes('/git/trees/' + MAIN_SHA), // exclude init tree fetch
    );

    const methods = apiCalls.map(c => c.method);
    expect(methods).toContain('GET');   // Step 1: get branch ref
    expect(methods).toContain('POST');  // Steps 2 & 3: create tree + commit
    expect(methods).toContain('PATCH'); // Step 4: update ref

    backend.shutdown();
  });

  it('creates a new pull request', async () => {
    const backend = await createBackend();

    const pr = await backend.createOrUpdatePR(
      'api-session/alice',
      'My edits',
      'Description of changes',
    );

    expect(pr.number).toBe(42);
    expect(pr.url).toContain('/pull/42');

    backend.shutdown();
  });

  it('updates an existing PR instead of creating a new one', async () => {
    // Override to return an existing PR in the list
    apiHandlers.push((url) => {
      if (url.includes('/pulls?')) {
        return {
          status: 200,
          body: [{ number: 99, html_url: 'https://github.com/testowner/testrepo/pull/99' }],
        };
      }
      return null!;
    });

    const backend = await createBackend();
    const pr = await backend.createOrUpdatePR('api-session/alice', 'Updated title', 'Updated body');

    expect(pr.number).toBe(99);

    // Verify PATCH was called on the existing PR
    const patchCall = fetchCalls.find(c =>
      c.method === 'PATCH' && c.url.includes('/pulls/99'),
    );
    expect(patchCall).toBeDefined();

    backend.shutdown();
  });

  it('compares branches and returns divergence info', async () => {
    const backend = await createBackend();

    const result = await backend.compareBranches('main', 'api-session/alice');

    expect(result.ahead_by).toBe(3);
    expect(result.behind_by).toBe(1);
    expect(result.status).toBe('ahead');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].filename).toBe('taxonomy/nodes.json');

    backend.shutdown();
  });

  it('merges main into a session branch', async () => {
    const backend = await createBackend();

    const result = await backend.mergeBranch('api-session/alice');

    expect(result.ok).toBe(true);
    expect(result.sha).toBe(COMMIT_SHA);
    expect(result.conflicts).toBe(false);

    backend.shutdown();
  });

  it('reports merge conflict when API returns 409', async () => {
    apiHandlers.push((url, init) => {
      if (url.includes('/merges') && init.method === 'POST') {
        return { status: 409, body: { message: 'Merge conflict' } };
      }
      return null!;
    });

    const backend = await createBackend();
    const result = await backend.mergeBranch('api-session/alice');

    expect(result.ok).toBe(false);
    expect(result.conflicts).toBe(true);
    expect(result.message).toContain('Merge conflict');

    backend.shutdown();
  });

  it('returns "already up to date" on 204 merge response', async () => {
    apiHandlers.push((url, init) => {
      if (url.includes('/merges') && init.method === 'POST') {
        return { status: 204, body: null };
      }
      return null!;
    });

    const backend = await createBackend();
    const result = await backend.mergeBranch('api-session/alice');

    expect(result.ok).toBe(true);
    expect(result.message).toContain('Already up to date');

    backend.shutdown();
  });

  it('lists directories from the in-memory tree', async () => {
    const backend = await createBackend();

    const entries = await backend.listDirectory('/taxonomy');
    expect(entries).toContain('nodes.json');
    expect(entries).toContain('edges.json');

    backend.shutdown();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SESSION BRANCH MANAGER — INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!UNDICI_ALIGNED)('SessionBranchManager — integration', () => {
  it('creates a session branch lazily on ensureBranch', async () => {
    // Mock branch not found initially, then found after creation
    const createdBranches = new Set<string>();
    apiHandlers.push((url, init) => {
      if (url.includes('/git/refs/heads/api-session/') && init.method === 'GET') {
        const branchName = url.split('/git/refs/heads/')[1];
        if (!createdBranches.has(branchName)) {
          return { status: 404, body: { message: 'Not Found' } };
        }
      }
      if (url.includes('/git/refs') && init.method === 'POST') {
        const body = JSON.parse(init.body as string);
        const ref = (body.ref as string).replace('refs/heads/', '');
        createdBranches.add(ref);
      }
      return null!;
    });

    const { manager, backend } = await createSessionManager();

    const branch = await manager.ensureBranch('alice@example.com');
    expect(branch).toBe('api-session/alice-example.com');

    // Second call returns cached branch
    const branch2 = await manager.ensureBranch('alice@example.com');
    expect(branch2).toBe(branch);

    backend.shutdown();
  });

  it('resumes an existing branch from GitHub', async () => {
    // Branch exists on GitHub
    const { manager, backend } = await createSessionManager();

    const branch = await manager.ensureBranch('bob@example.com');
    expect(branch).toBe('api-session/bob-example.com');

    // Verify session state is tracked
    const state = manager.getSessionState('bob@example.com');
    expect(state).toBeDefined();
    expect(state!.branchName).toBe('api-session/bob-example.com');

    backend.shutdown();
  });

  it('batch commits files with mutex serialization', async () => {
    const { manager, backend } = await createSessionManager();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    // ensureBranch first (branch already exists on GitHub per default mock)
    await manager.ensureBranch('alice');

    const sha = await manager.commitBatch('alice', [
      { path: 'taxonomy/nodes.json', content: '{"v":2}' },
      { path: 'taxonomy/edges.json', content: '{"v":2}' },
    ]);

    expect(sha).toBe(COMMIT_SHA);

    // Verify session state updated
    const state = manager.getSessionState('alice');
    expect(state?.lastCommitSha).toBe(COMMIT_SHA);
    expect(state?.lastCommitAt).toBeGreaterThan(0);

    backend.shutdown();
  });

  it('rejects empty batch commits', async () => {
    const { manager, backend } = await createSessionManager();

    await expect(manager.commitBatch('alice', [])).rejects.toThrow(/No files to commit/);

    backend.shutdown();
  });

  it('creates a PR from a session branch', async () => {
    const { manager, backend } = await createSessionManager();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    // ensureBranch + commit first
    await manager.ensureBranch('alice');
    await manager.commitBatch('alice', [
      { path: 'taxonomy/nodes.json', content: '{"v":2}' },
    ]);

    const pr = await manager.createPR('alice', 'My changes', 'Description');
    expect(pr.number).toBe(42);
    expect(pr.url).toContain('/pull/42');

    // Verify state tracks PR
    const state = manager.getSessionState('alice');
    expect(state?.prNumber).toBe(42);

    backend.shutdown();
  });

  it('rejects createPR when no session branch exists', async () => {
    const { manager, backend } = await createSessionManager();

    await expect(manager.createPR('alice')).rejects.toThrow(/No active session branch/);

    backend.shutdown();
  });

  it('deletes a session branch and clears state', async () => {
    const { manager, backend } = await createSessionManager();

    // Create a session first
    await manager.ensureBranch('charlie@example.com');
    expect(manager.getActiveBranch('charlie@example.com')).toBeDefined();

    await manager.deleteBranch('charlie@example.com', 'manual');

    expect(manager.getActiveBranch('charlie@example.com')).toBeUndefined();
    expect(manager.getSessionState('charlie@example.com')).toBeUndefined();

    // Verify DELETE was called on GitHub
    const deleteCall = fetchCalls.find(c =>
      c.method === 'DELETE' && c.url.includes('/git/refs/heads/'),
    );
    expect(deleteCall).toBeDefined();

    backend.shutdown();
  });

  it('reports divergence between session and main', async () => {
    const { manager, backend } = await createSessionManager();

    await manager.ensureBranch('alice@example.com');
    const div = await manager.getDivergence('alice@example.com');

    expect(div).toBeDefined();
    expect(div!.ahead_by).toBe(3);
    expect(div!.behind_by).toBe(1);

    backend.shutdown();
  });

  it('returns null divergence for unknown user', async () => {
    const { manager, backend } = await createSessionManager();

    const div = await manager.getDivergence('nobody@example.com');
    expect(div).toBeNull();

    backend.shutdown();
  });

  it('tracks active session count', async () => {
    const { manager, backend } = await createSessionManager();

    expect(manager.getActiveSessionCount()).toBe(0);

    await manager.ensureBranch('alice@example.com');
    expect(manager.getActiveSessionCount()).toBe(1);

    await manager.ensureBranch('bob@example.com');
    expect(manager.getActiveSessionCount()).toBe(2);

    await manager.deleteBranch('alice@example.com');
    expect(manager.getActiveSessionCount()).toBe(1);

    backend.shutdown();
  });

  it('degrades-and-proceeds when branchExistsOnGitHub times out (t/3267)', async () => {
    // Simulate the OS-TCP-timeout scenario: the branch existence fetch throws
    // an AbortError (what the 10s AbortController fires). The fix must degrade
    // to false (branch absent) so createBranch is called and the save succeeds.
    apiHandlers.push((url, init) => {
      if (url.includes('/git/refs/heads/api-session/') && (init.method ?? 'GET') === 'GET') {
        throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
      }
      return null!;
    });

    const { manager, backend: be } = await createSessionManager();

    // Must NOT throw — degrade-and-proceed: AbortError → treat branch absent → createBranch
    const branch = await manager.ensureBranch('alice@example.com');
    expect(branch).toBe('api-session/alice-example.com');

    // createBranch (POST /git/refs) must have been called — proves the degrade-and-proceed
    // path completed: timeout → false → createBranch → 201 → session established
    const createCall = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/git/refs'));
    expect(createCall).toBeDefined();

    be.shutdown();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MULTI-USER ISOLATION
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!UNDICI_ALIGNED)('SessionBranchManager — multi-user isolation', () => {
  it('maintains separate branches for different users', async () => {
    const createdBranches = new Set<string>();
    apiHandlers.push((url, init) => {
      if (url.includes('/git/refs/heads/api-session/') && init.method === 'GET') {
        const branchName = url.split('/git/refs/heads/')[1];
        if (!createdBranches.has(branchName)) {
          return { status: 404, body: { message: 'Not Found' } };
        }
      }
      if (url.includes('/git/refs') && init.method === 'POST') {
        const body = JSON.parse(init.body as string);
        createdBranches.add((body.ref as string).replace('refs/heads/', ''));
      }
      return null!;
    });

    const { manager, backend } = await createSessionManager();

    const branchA = await manager.ensureBranch('alice@example.com');
    const branchB = await manager.ensureBranch('bob@example.com');

    expect(branchA).not.toBe(branchB);
    expect(branchA).toContain('alice');
    expect(branchB).toContain('bob');

    backend.shutdown();
  });

  it('session overlay is per-user', async () => {
    const { manager, backend } = await createSessionManager();

    // Alice writes
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    await backend.writeFile('/taxonomy/nodes.json', '{"alice": true}');

    // Bob writes
    backend.setSessionContext({ userId: 'bob', branchName: 'api-session/bob' });
    await backend.writeFile('/taxonomy/nodes.json', '{"bob": true}');

    // Verify separate overlays
    const aliceOverlay = backend.getSessionOverlay('alice');
    const bobOverlay = backend.getSessionOverlay('bob');

    expect(aliceOverlay?.get('taxonomy/nodes.json')).toBe('{"alice": true}');
    expect(bobOverlay?.get('taxonomy/nodes.json')).toBe('{"bob": true}');

    backend.shutdown();
  });

  it('reads from session overlay reflect user edits, not main', async () => {
    const { manager, backend } = await createSessionManager();

    // Alice writes, then reads — should see her edit
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    await backend.writeFile('/taxonomy/nodes.json', '{"alice": true}');

    const content = await backend.readFile('/taxonomy/nodes.json');
    expect(content).toBe('{"alice": true}');

    backend.shutdown();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BRANCH NAME SANITIZATION
// ═══════════════════════════════════════════════════════════════════════════

describe('sanitizeBranchName', () => {
  let sanitize: typeof import('../storage/sessionBranchManager').sanitizeBranchName;

  beforeEach(async () => {
    const mod = await import('../storage/sessionBranchManager');
    sanitize = mod.sanitizeBranchName;
  });

  it('lowercases and removes @ from emails', () => {
    // Note: dots in domain are preserved (not in disallowed git ref chars)
    expect(sanitize('Alice@Example.COM')).toBe('alice-example.com');
  });

  it('removes disallowed git ref characters', () => {
    expect(sanitize('user~with^bad:chars?here*now')).toBe('user-with-bad-chars-here-now');
  });

  it('collapses consecutive dashes', () => {
    expect(sanitize('user---name')).toBe('user-name');
  });

  it('trims leading and trailing dashes', () => {
    expect(sanitize('-username-')).toBe('username');
  });

  it('replaces .lock suffix', () => {
    expect(sanitize('branch.lock')).toBe('branch-lock');
  });

  it('throws on empty result', () => {
    expect(() => sanitize('@@@@')).toThrow(/empty branch name/);
  });

  it('truncates long names', () => {
    const longName = 'a'.repeat(200);
    const result = sanitize(longName);
    // api-session/ prefix is 12 chars, so segment max is 88
    expect(result.length).toBeLessThanOrEqual(88);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CHAOS TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — chaos: rate limit exhaustion', () => {
  it('retries on 429 with Retry-After header', async () => {
    let callCount = 0;
    apiHandlers.push((url, init) => {
      if (url.includes('/contents/') && init.method === 'GET') {
        callCount++;
        if (callCount <= 2) {
          return {
            status: 429,
            body: { message: 'rate limit exceeded' },
            headers: {
              ...defaultRateLimitHeaders,
              'retry-after': '0', // 0 seconds for test speed
              'x-ratelimit-remaining': '0',
            },
          };
        }
        // Third attempt succeeds
        return {
          status: 200,
          body: { content: Buffer.from('recovered').toString('base64'), encoding: 'base64', sha: 'x' },
        };
      }
      return null!;
    });

    const recorder = createTestRecorder();
    const backend = await createBackend(recorder);
    const content = await backend.readFile('/taxonomy/nodes.json');

    expect(content).toBe('recovered');
    expect(callCount).toBe(3);

    // Verify rate limit event was recorded
    const rateLimitEvents = recorder.events.filter(e => e.type === 'github.api.rate_limit');
    expect(rateLimitEvents.length).toBeGreaterThan(0);

    backend.shutdown();
  });
});

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — chaos: circuit breaker', () => {
  it('opens after 5 consecutive failures and blocks requests', async () => {
    let failCount = 0;
    apiHandlers.push((url, init) => {
      // Fail all Contents API calls to trigger circuit breaker
      if (url.includes('/contents/') && init.method === 'GET') {
        failCount++;
        return { status: 500, body: { message: 'Internal Server Error' } };
      }
      return null!;
    });

    const recorder = createTestRecorder();
    const backend = await createBackend(recorder);

    // Make 5+ failing requests to trip the circuit breaker
    // Each request retries 3 times internally, but we need 5 consecutive failures
    // counted by onApiFailure. With MAX_RETRIES=3, each readFile causes 4 attempts.
    for (let i = 0; i < 2; i++) {
      await backend.readFile(`/file${i}.json`);
    }

    // Circuit should be open now
    expect(backend.getCircuitState()).toBe('open');

    // Further reads should return null without hitting the API
    const callsBefore = fetchCalls.length;
    const result = await backend.readFile('/another-file.json');
    expect(result).toBeNull();

    // Verify circuit breaker event
    const cbEvents = recorder.events.filter(e => e.type === 'github.api.circuit_break');
    expect(cbEvents.some(e => e.message?.includes('→ open'))).toBe(true);

    backend.shutdown();
  });

  it('blocks writes when circuit is open (direct write mode)', async () => {
    // Trip the circuit breaker
    apiHandlers.push((url, init) => {
      if (url.includes('/contents/')) {
        return { status: 500, body: { message: 'Internal Server Error' } };
      }
      return null!;
    });

    const backend = await createBackend();
    // No session context → writeFile uses Contents API directly (overlay skipped)

    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      await backend.readFile(`/file${i}.json`);
    }

    expect(backend.getCircuitState()).toBe('open');

    await expect(backend.writeFile('/taxonomy/nodes.json', '{}')).rejects.toThrow(
      /circuit breaker open/i,
    );

    backend.shutdown();
  });
});

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — chaos: GitHub outage (5xx)', () => {
  it('retries on 500 with exponential backoff', async () => {
    let callCount = 0;
    apiHandlers.push((url, init) => {
      if (url.includes('/contents/') && init.method === 'GET') {
        callCount++;
        if (callCount <= 2) {
          return { status: 503, body: { message: 'Service Unavailable' } };
        }
        return {
          status: 200,
          body: { content: Buffer.from('recovered').toString('base64'), encoding: 'base64', sha: 'x' },
        };
      }
      return null!;
    });

    const backend = await createBackend();
    const content = await backend.readFile('/taxonomy/nodes.json');

    expect(content).toBe('recovered');
    expect(callCount).toBe(3);

    backend.shutdown();
  });

  it('returns null after all retries exhausted on read', async () => {
    apiHandlers.push((url, init) => {
      if (url.includes('/contents/') && init.method === 'GET') {
        return { status: 500, body: { message: 'Internal Server Error' } };
      }
      return null!;
    });

    const backend = await createBackend();
    const content = await backend.readFile('/taxonomy/nodes.json');

    // readFile returns null on failure (does not throw)
    expect(content).toBeNull();

    backend.shutdown();
  });
});

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — chaos: token expiry mid-batch', () => {
  it('refreshes credentials on 401 and retries', async () => {
    let attempt = 0;
    apiHandlers.push((url, init) => {
      // First call to any Contents API returns 401
      if (url.includes('/contents/') && init.method === 'GET') {
        attempt++;
        if (attempt === 1) {
          return { status: 401, body: { message: 'Bad credentials' } };
        }
        return {
          status: 200,
          body: { content: Buffer.from('ok').toString('base64'), encoding: 'base64', sha: 'x' },
        };
      }
      return null!;
    });

    const backend = await createBackend();
    const content = await backend.readFile('/taxonomy/nodes.json');

    expect(content).toBe('ok');
    expect(attempt).toBe(2); // first 401, then success

    backend.shutdown();
  });

  // Characterization (t/1698): a 401 on a LATER call of a multi-apiRequest operation
  // must still self-refresh and let the whole operation complete. Pins the in-request
  // 401 refresh/retry inside a batch BEFORE that logic moves into GitHubRestClient, so
  // the extraction cannot silently break mid-batch credential recovery.
  it('mid-batch 401 refreshes creds and the multi-step commit still completes', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    let treePost = 0;
    apiHandlers.push((url, init) => {
      if (url.includes('/git/trees') && init.method === 'POST') {
        treePost++;
        if (treePost === 1) return { status: 401, body: { message: 'Bad credentials' } };
      }
      return null!; // fall through to default success handlers for all other steps
    });

    const sha = await backend.createCommitFromTree(
      'api-session/alice',
      [{ path: 'taxonomy/nodes.json', content: '{"v":2}' }],
      'Test commit',
    );

    expect(sha).toBe(COMMIT_SHA);   // step 2 (tree POST) 401'd once, refreshed + retried, batch completed
    expect(treePost).toBe(2);       // 401 then retry

    backend.shutdown();
  });
});

// Characterization (t/1698): the circuit-open short-circuit is inlined in 8 storage
// methods; only readFile (returns null) and writeFile (throws) were pinned. These pin
// the remaining behaviors so moving `circuitState`/`shouldProbe` into GitHubRestClient
// (each site → `this.rest.isTripped()`) cannot silently change any of them. NOTE:
// listDirectory's circuit guard is only reachable when repoTree is empty (normally
// populated by initialize()), so it is a mechanical-only substitution not independently
// characterized here — flagged, not forced (t/1698 escape hatch).
describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — circuit-open short-circuit per method (t/1698)', () => {
  const openCircuit = async (backend: Awaited<ReturnType<typeof createBackend>>) => {
    apiHandlers.push((url, init) => {
      if (url.includes('/contents/') && init.method === 'GET') {
        return { status: 500, body: { message: 'Internal Server Error' } };
      }
      return null!;
    });
    for (let i = 0; i < 2; i++) await backend.readFile(`/trip${i}.json`);
    expect(backend.getCircuitState()).toBe('open');
  };

  it('readBinaryFile returns null when the circuit is open', async () => {
    const backend = await createBackend();
    await openCircuit(backend);
    expect(await backend.readBinaryFile('/some.bin')).toBeNull();
    backend.shutdown();
  });

  it('readFileAtRef returns null when the circuit is open', async () => {
    const backend = await createBackend();
    await openCircuit(backend);
    expect(await backend.readFileAtRef('taxonomy/nodes.json', 'feature-branch')).toBeNull();
    backend.shutdown();
  });

  it('writeBinaryFile throws when the circuit is open (direct write mode)', async () => {
    const backend = await createBackend();
    await openCircuit(backend);
    await expect(backend.writeBinaryFile('/taxonomy/blob.bin', Buffer.from('x'))).rejects.toThrow(
      /circuit breaker open/i,
    );
    backend.shutdown();
  });

  it('deleteFile throws when the circuit is open (direct write mode)', async () => {
    const backend = await createBackend();
    await openCircuit(backend);
    await expect(backend.deleteFile('/taxonomy/nodes.json')).rejects.toThrow(/circuit breaker open/i);
    backend.shutdown();
  });

  it('fileExists returns false when the circuit is open', async () => {
    const backend = await createBackend();
    await openCircuit(backend);
    expect(await backend.fileExists('/nonexistent-xyz.json')).toBe(false);
    backend.shutdown();
  });
});

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — chaos: force push on main', () => {
  it('triggers full cache invalidation on 404 compare', async () => {
    apiHandlers.push((url) => {
      // Compare returns 404 when cached SHA no longer in history
      if (url.includes('/compare/')) {
        return { status: 404, body: { message: 'Not Found' } };
      }
      return null!;
    });

    const recorder = createTestRecorder();
    const backend = await createBackend(recorder);

    const changed = await backend.getChangedFiles('old-sha', 'new-sha');
    expect(changed).toEqual([]); // Returns empty on failure

    // Verify cache invalidation was triggered
    const invalidateEvents = recorder.events.filter(e => e.type === 'cache.invalidate');
    expect(invalidateEvents.some(e => e.message?.includes('Force push'))).toBe(true);

    backend.shutdown();
  });

  it('triggers full cache invalidation on 422 compare', async () => {
    apiHandlers.push((url) => {
      if (url.includes('/compare/')) {
        return { status: 422, body: { message: 'No common ancestor' } };
      }
      return null!;
    });

    const recorder = createTestRecorder();
    const backend = await createBackend(recorder);

    await backend.getChangedFiles('old-sha', 'new-sha');

    const invalidateEvents = recorder.events.filter(e => e.type === 'cache.invalidate');
    expect(invalidateEvents.some(e => e.message?.includes('Force push'))).toBe(true);

    backend.shutdown();
  });
});

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — chaos: network errors', () => {
  it('retries and recovers from transient network errors', async () => {
    let callCount = 0;
    apiHandlers.push((url, init) => {
      if (url.includes('/contents/') && init.method === 'GET') {
        callCount++;
        if (callCount <= 2) {
          throw new TypeError('fetch failed');
        }
        return {
          status: 200,
          body: { content: Buffer.from('recovered').toString('base64'), encoding: 'base64', sha: 'x' },
        };
      }
      return null!;
    });

    const backend = await createBackend();
    const content = await backend.readFile('/taxonomy/nodes.json');

    expect(content).toBe('recovered');
    expect(callCount).toBe(3);

    backend.shutdown();
  });
});

describe.skipIf(!UNDICI_ALIGNED)('SessionBranchManager — chaos: multi-tab race', () => {
  it('serializes concurrent commits from same user via mutex', async () => {
    const { manager, backend } = await createSessionManager();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    // Pre-create branch
    await manager.ensureBranch('alice');

    // Fire two concurrent commits
    const results = await Promise.all([
      manager.commitBatch('alice', [
        { path: 'taxonomy/nodes.json', content: '{"tab1": true}' },
      ]),
      manager.commitBatch('alice', [
        { path: 'taxonomy/edges.json', content: '{"tab2": true}' },
      ]),
    ]);

    // Both should succeed (serialized, not concurrent)
    expect(results[0]).toBe(COMMIT_SHA);
    expect(results[1]).toBe(COMMIT_SHA);

    backend.shutdown();
  });

  it('different users can commit concurrently (no mutex contention)', async () => {
    const { manager, backend } = await createSessionManager();

    // Pre-create branches for both users
    await manager.ensureBranch('alice');
    await manager.ensureBranch('bob');

    const results = await Promise.all([
      (async () => {
        backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
        return manager.commitBatch('alice', [
          { path: 'taxonomy/nodes.json', content: '{"alice": true}' },
        ]);
      })(),
      (async () => {
        backend.setSessionContext({ userId: 'bob', branchName: 'api-session/bob' });
        return manager.commitBatch('bob', [
          { path: 'taxonomy/nodes.json', content: '{"bob": true}' },
        ]);
      })(),
    ]);

    expect(results[0]).toBe(COMMIT_SHA);
    expect(results[1]).toBe(COMMIT_SHA);

    backend.shutdown();
  });
});

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — chaos: missing credentials', () => {
  it('initializes in fallback mode with no credentials', async () => {
    const { getCredentials } = await import('../security/githubAppAuth');
    (getCredentials as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const recorder = createTestRecorder();
    const backend = await createBackend(recorder);

    // Should still init, but in fallback mode
    const fallbackEvents = recorder.events.filter(e => e.type === 'storage.fallback');
    expect(fallbackEvents.length).toBeGreaterThan(0);

    backend.shutdown();
  });

  it('throws noCredsError on write when credentials are missing (direct write mode)', async () => {
    const { getCredentials } = await import('../security/githubAppAuth');
    (getCredentials as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
    const backend = new GitHubAPIBackend({
      cacheDir: '/var/cache/taxonomy-test-nocreds', // non-tmpdir: breaks CodeQL /tmp taint flow (t/2020)
      pollIntervalMs: 999_999_999,
      coherencyProbeRate: 0,
    });
    await backend.initialize();
    // No session context → writeFile uses Contents API directly (overlay skipped)

    await expect(backend.writeFile('/taxonomy/nodes.json', '{}')).rejects.toThrow(
      /No GitHub credentials configured/,
    );

    backend.shutdown();

    // Restore mock
    (getCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
      repo: 'testowner/testrepo',
      token: 'test-token-abc123',
      mode: 'pat' as const,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CACHE BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — cache behavior', () => {
  it('serves from session overlay on cache hit', async () => {
    const recorder = createTestRecorder();
    const backend = await createBackend(recorder);

    // Populate overlay
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    await backend.writeFile('/taxonomy/nodes.json', '{"cached": true}');

    // Reset fetch tracking
    fetchCalls.length = 0;

    // Read should come from overlay, not GitHub
    const content = await backend.readFile('/taxonomy/nodes.json');
    expect(content).toBe('{"cached": true}');

    // No additional fetch calls for the read (overlay hit)
    const contentsFetches = fetchCalls.filter(c => c.url.includes('/contents/taxonomy/nodes.json'));
    expect(contentsFetches).toHaveLength(0);

    backend.shutdown();
  });

  it('tracks cache generation counter', async () => {
    const backend = await createBackend();

    // Generation should be a positive number after init (manifest was created/loaded)
    expect(typeof backend.getCacheGeneration()).toBe('number');

    backend.shutdown();
  });

  it('clears session overlay on clearSessionOverlay', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    await backend.writeFile('/taxonomy/nodes.json', '{"alice": true}');

    expect(backend.getSessionOverlay('alice')?.size).toBeGreaterThan(0);

    backend.clearSessionOverlay('alice');
    expect(backend.getSessionOverlay('alice')).toBeUndefined();

    backend.shutdown();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// listDirectory OVERLAY MERGE (t/681 — admin review queue fix)
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — listDirectory overlay merge (t/681)', () => {
  it('includes files written to the session overlay but not yet committed', async () => {
    // Repro of the admin-review bug: submissions written to the overlay were
    // invisible to listDirectory() until the overlay was flushed on commit.
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    await backend.writeFile('/community/_submissions/sub-1.json', '{"id":"1"}');
    await backend.writeFile('/community/_submissions/sub-2.json', '{"id":"2"}');

    const entries = await backend.listDirectory('/community/_submissions');
    expect(entries).toContain('sub-1.json');
    expect(entries).toContain('sub-2.json');

    backend.shutdown();
  });

  it('merges overlay files into an existing tree-backed directory without duplicates', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    // taxonomy/ already holds nodes.json + edges.json from the repo tree.
    await backend.writeFile('/taxonomy/new-file.json', '{"new":true}');

    const entries = await backend.listDirectory('/taxonomy');
    expect(entries).toContain('nodes.json');    // from tree
    expect(entries).toContain('edges.json');     // from tree
    expect(entries).toContain('new-file.json');  // from overlay
    expect(new Set(entries).size).toBe(entries.length); // no dupes

    backend.shutdown();
  });

  it('hides tombstoned (deleted) files from the listing', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    // edges.json exists in the tree; delete it in this session (overlay tombstone).
    await backend.deleteFile('/taxonomy/edges.json');

    const entries = await backend.listDirectory('/taxonomy');
    expect(entries).toContain('nodes.json');
    expect(entries).not.toContain('edges.json');

    backend.shutdown();
  });

  it('surfaces a new subdirectory created only in the overlay', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    await backend.writeFile('/community/chats/chat-1.json', '{}');

    const top = await backend.listDirectory('/community');
    expect(top).toContain('chats');

    const sub = await backend.listDirectory('/community/chats');
    expect(sub).toContain('chat-1.json');

    backend.shutdown();
  });

  it('does not merge overlay when the effective ref is main', async () => {
    const backend = await createBackend();
    // Write under an active session branch...
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    await backend.writeFile('/taxonomy/session-only.json', '{}');

    // ...then drop to a main-ref context (no branch name).
    backend.setSessionContext({ userId: 'alice' });
    const entries = await backend.listDirectory('/taxonomy');
    expect(entries).not.toContain('session-only.json');

    backend.shutdown();
  });

  it('keeps overlays isolated per user', async () => {
    const backend = await createBackend();

    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    await backend.writeFile('/community/_submissions/alice.json', '{}');

    backend.setSessionContext({ userId: 'bob', branchName: 'api-session/bob' });
    await backend.writeFile('/community/_submissions/bob.json', '{}');

    const bobEntries = await backend.listDirectory('/community/_submissions');
    expect(bobEntries).toContain('bob.json');
    expect(bobEntries).not.toContain('alice.json');

    backend.shutdown();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DIAGNOSTIC ACCESSORS
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — diagnostic accessors', () => {
  it('exposes rate limit info', async () => {
    const backend = await createBackend();

    expect(backend.getRateLimitRemaining()).toBe(4999);
    expect(backend.getRateLimitResetsAt()).toBeTruthy();

    backend.shutdown();
  });

  it('exposes circuit breaker state', async () => {
    const backend = await createBackend();

    expect(backend.getCircuitState()).toBe('closed');

    backend.shutdown();
  });

  it('exposes error buffer', async () => {
    const backend = await createBackend();

    // Should be an array (possibly empty)
    expect(Array.isArray(backend.getErrorBuffer())).toBe(true);

    backend.shutdown();
  });

  // Characterization test (t/1688): recordEvent pushes error/warn-level events to
  // the secondary error buffer (t/465#5). This behavior — recordEvent + errorBuffer
  // — moves into GitHubRestClient during the transport-seam extraction; pin the
  // failure→buffer population against the unmodified class BEFORE the rewire so the
  // extraction cannot silently drop it.
  it('populates the error buffer on API failure', async () => {
    apiHandlers.push((url, init) => {
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/contents/')) {
        return { status: 500, body: { message: 'Internal Server Error' } };
      }
      return null as never;
    });

    const backend = await createBackend();
    const result = await backend.readFile('/taxonomy/nodes.json');
    expect(result).toBeNull(); // read fails (returns null) after retries exhausted

    const buffered = backend.getErrorBuffer();
    expect(buffered.length).toBeGreaterThan(0);
    expect(buffered.some(e => e.type === 'github.api.error' && e.level === 'error')).toBe(true);

    backend.shutdown();
  });

  it('counts active branches via session overlays', async () => {
    const backend = await createBackend();

    expect(backend.getActiveBranchCount()).toBe(0);

    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    await backend.writeFile('/taxonomy/nodes.json', '{}');

    expect(backend.getActiveBranchCount()).toBe(1);

    backend.shutdown();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MANIFEST MUTEX (t/479 — RMW race fix)
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — manifest mutex', () => {
  it('concurrent readFile cache misses preserve all manifest entries', async () => {
    // Simulate the Phase 2 loadAll() pattern: 3 concurrent readFile() calls
    // that all miss cache, each fetching from GitHub and writing to manifest.
    // Before the mutex fix, the shared .tmp file would corrupt concurrent saves.
    const fileContents: Record<string, string> = {
      'taxonomy/safetyist.json': '{"pov": "safetyist"}',
      'taxonomy/skeptic.json': '{"pov": "skeptic"}',
      'taxonomy/situations.json': '{"situations": []}',
    };

    // Return distinct content per file path
    apiHandlers.push((url, init) => {
      if (init.method === 'GET' || !init.method) {
        for (const [repoPath, content] of Object.entries(fileContents)) {
          if (url.includes(`/contents/${repoPath}`)) {
            return {
              status: 200,
              body: {
                content: Buffer.from(content).toString('base64'),
                encoding: 'base64',
                sha: `sha-${repoPath.replace(/[/.]/g, '-')}`,
              },
              headers: { etag: `"etag-${repoPath}"` },
            };
          }
        }
      }
      return null!;
    });

    const backend = await createBackend();

    // Fire 3 concurrent reads — all cache misses
    const paths = Object.keys(fileContents);
    const results = await Promise.all(
      paths.map(p => backend.readFile(`/var/cache/taxonomy-test/${p}`)),
    );

    // All reads should succeed
    expect(results[0]).toBe(fileContents[paths[0]]);
    expect(results[1]).toBe(fileContents[paths[1]]);
    expect(results[2]).toBe(fileContents[paths[2]]);

    // The manifest should contain ALL 3 entries (the old race would lose some)
    expect(backend.getCachedFileCount()).toBeGreaterThanOrEqual(3);

    backend.shutdown();
  });

  it('concurrent writes do not corrupt manifest on disk', async () => {
    // Verify that saveManifest calls are serialized: the fs.writeFile mock
    // should never be called with a .tmp path while a prior .tmp write is
    // still in flight. We track overlapping writes.
    const fsPromises = await import('fs/promises');
    const mockWriteFile = vi.mocked(fsPromises.default.writeFile);

    let activeWrites = 0;
    let maxConcurrentWrites = 0;
    mockWriteFile.mockImplementation(async (filePath) => {
      const fp = typeof filePath === 'string' ? filePath : String(filePath);
      if (fp.includes('manifest.json.tmp')) {
        activeWrites++;
        maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
        // Simulate I/O delay to widen the race window
        await new Promise(r => setTimeout(r, 10));
        activeWrites--;
      }
    });

    const backend = await createBackend();

    // Fire 5 concurrent readFile cache misses
    const paths = Array.from({ length: 5 }, (_, i) => `taxonomy/file${i}.json`);
    apiHandlers.push((url, init) => {
      if (init.method === 'GET' || !init.method) {
        for (const p of paths) {
          if (url.includes(`/contents/${p}`)) {
            return {
              status: 200,
              body: {
                content: Buffer.from(`{"i": ${p}}`).toString('base64'),
                encoding: 'base64',
                sha: `sha-${p}`,
              },
            };
          }
        }
      }
      return null!;
    });

    await Promise.all(
      paths.map(p => backend.readFile(`/var/cache/taxonomy-test/${p}`)),
    );

    // With the manifest mutex, writes should be serialized (max 1 at a time)
    expect(maxConcurrentWrites).toBe(1);

    backend.shutdown();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SESSION OVERLAY MEMORY CAP (t/727)
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — session overlay memory cap (t/727)', () => {
  async function cappedBackend(capBytes: number) {
    const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
    const b = new GitHubAPIBackend({
      cacheDir: '/var/cache/taxonomy-test', // non-tmpdir: breaks CodeQL /tmp taint flow (t/2020)
      recorder: createTestRecorder(),
      pollIntervalMs: 999_999_999,
      coherencyProbeRate: 0,
      maxOverlayBytesPerUser: capBytes,
    });
    await b.initialize();
    b.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    return b;
  }

  it('allows writes under the cap and reports overlay bytes in stats', async () => {
    const b = await cappedBackend(2000);
    await b.writeFile('/taxonomy/a.json', 'x'.repeat(1000));
    const stats = b.getOverlayStats();
    expect(stats.totalBytes).toBe(1000);
    expect(stats.users).toBe(1);
    expect(stats.maxUserBytes).toBe(1000);
    expect(stats.capBytes).toBe(2000);
    b.shutdown();
  });

  it('rejects a write that would exceed the per-user cap with statusCode 413', async () => {
    const b = await cappedBackend(2000);
    await b.writeFile('/taxonomy/a.json', 'x'.repeat(1000));
    await expect(b.writeFile('/taxonomy/b.json', 'y'.repeat(1500))).rejects.toMatchObject({ statusCode: 413 });
    expect(b.getOverlayStats().totalBytes).toBe(1000); // rejected write not stored
    b.shutdown();
  });

  it('uses replace semantics — overwriting the same path does not double-count', async () => {
    const b = await cappedBackend(2000);
    await b.writeFile('/taxonomy/a.json', 'x'.repeat(1500));
    await b.writeFile('/taxonomy/a.json', 'y'.repeat(1500)); // replaces; projected 1500 ≤ 2000
    expect(b.getOverlayStats().totalBytes).toBe(1500);
    b.shutdown();
  });

  it('rejects a single write larger than the entire cap', async () => {
    const b = await cappedBackend(2000);
    await expect(b.writeFile('/taxonomy/big.json', 'z'.repeat(3000))).rejects.toMatchObject({ statusCode: 413 });
    expect(b.getOverlayStats().totalBytes).toBe(0);
    b.shutdown();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// OPTIONAL 404 LOG LEVEL (t/1339)
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — optional 404 log level', () => {
  it('logs non-optional 404 at error level with github.api.error type', async () => {
    apiHandlers.push((url, init) => {
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/contents/')) {
        return { status: 404, body: { message: 'Not Found' } };
      }
      return null as never;
    });

    const recorder = createTestRecorder();
    const backend = await createBackend(recorder);

    const result = await backend.readFile('/missing/file.json');
    expect(result).toBeNull();

    const errorEvents = recorder.events.filter(
      e => e.type === 'github.api.error' && e.data?.status === 404,
    );
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(errorEvents[0].level).toBe('error');

    backend.shutdown();
  });

  it('logs optional 404 at debug level with github.api.miss type', async () => {
    apiHandlers.push((url, init) => {
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/contents/')) {
        return { status: 404, body: { message: 'Not Found' } };
      }
      return null as never;
    });

    const recorder = createTestRecorder();
    const backend = await createBackend(recorder);

    const result = await backend.readFile('/missing/optional.json', { optional: true });
    expect(result).toBeNull();

    const missEvents = recorder.events.filter(
      e => e.type === 'github.api.miss' && e.data?.status === 404,
    );
    expect(missEvents.length).toBeGreaterThan(0);
    expect(missEvents[0].level).toBe('debug');

    const errorEvents = recorder.events.filter(
      e => e.type === 'github.api.error' && e.data?.status === 404,
    );
    expect(errorEvents).toHaveLength(0);

    backend.shutdown();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// t/2053 regression: undici dispatcher ownership + data-load status
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — undici dispatcher (t/2053)', () => {
  it('passes explicit dispatcher on every fetch call', async () => {
    await createBackend();

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, init] of calls) {
      expect((init as RequestInit & { dispatcher?: unknown }).dispatcher).toBeInstanceOf(Agent);
    }
  });

  it('reports ready status after successful initialization', async () => {
    const backend = await createBackend();

    expect(backend.getDataLoadStatus().status).toBe('ready');

    backend.shutdown();
  });

  it('reports failed status and logs error when tree loads 0 blobs', async () => {
    // Simulate undici 6.28.0 returning empty tree (the :07-30 prod failure mode)
    apiHandlers.push((url) => {
      if (url.includes('/git/trees/')) return { status: 200, body: { sha: TREE_SHA, truncated: false, tree: [] } };
      return null as unknown as { status: number; body: unknown };
    });

    const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
    const recorder = createTestRecorder();
    const backend = new GitHubAPIBackend({
      cacheDir: '/var/cache/taxonomy-test',
      recorder,
      pollIntervalMs: 999_999_999,
      coherencyProbeRate: 0,
    });
    await backend.initialize();

    const { status } = backend.getDataLoadStatus();
    expect(status).toBe('failed');

    // Error must surface in flight recorder (not swallowed at info-level)
    const errorEvents = recorder.events.filter(e => e.level === 'error');
    expect(errorEvents.length).toBeGreaterThan(0);

    backend.shutdown();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// t/2670: toRepoPath must strip getDataRoot(), not cacheDir — separate cache
// mount must not 404 all github-api reads.
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!UNDICI_ALIGNED)('toRepoPath strips getDataRoot() not cacheDir (t/2670)', () => {
  // Simulate a staging deployment where TAXONOMY_CACHE_DIR != AI_TRIAD_DATA_ROOT.
  // cacheDir comes from createBackend() = '/var/cache/taxonomy-test'.
  // getDataRoot() reads AI_TRIAD_DATA_ROOT; stub it to a distinct value.
  const FAKE_DATA_ROOT = '/mnt/shared-data';

  beforeEach(() => { vi.stubEnv('AI_TRIAD_DATA_ROOT', FAKE_DATA_ROOT); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('resolves a getDataRoot()-prefixed absolute path to a repo-relative path when cacheDir differs', async () => {
    const backend = await createBackend(); // cacheDir = /var/cache/taxonomy-test

    // File path as fileIO.ts constructs it: absolute, rooted at getDataRoot().
    await backend.readFile(`${FAKE_DATA_ROOT}/taxonomy/nodes.json`);

    // The GitHub Contents API call must use the repo-relative path.
    // With the bug (strip cacheDir): prefix not stripped → URL gets 'mnt/shared-data/taxonomy/...'
    // With the fix (strip dataRoot): prefix stripped → URL gets 'taxonomy/nodes.json'
    const contentCall = fetchCalls.find(c => c.method === 'GET' && c.url.includes('/contents/'));
    expect(contentCall).toBeDefined();
    expect(contentCall!.url).toContain('/contents/taxonomy/nodes.json');
    expect(contentCall!.url).not.toContain('mnt/shared-data');

    backend.shutdown();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// t/2113: undici major-version invariant — gate fires from both directions
// ═══════════════════════════════════════════════════════════════════════════

describe('assertUndiciMajorInvariant', () => {
  it('passes when userland and bundled majors match', () => {
    expect(() => assertUndiciMajorInvariant('6.28.0', '6.21.0')).not.toThrow();
    expect(() => assertUndiciMajorInvariant('7.0.0', '7.24.4')).not.toThrow();
  });

  it('throws when bundled major is ahead of userland (node base-image bumped without package.json update)', () => {
    expect(() => assertUndiciMajorInvariant('6.28.0', '7.24.4')).toThrow(/undici major-version skew/);
    expect(() => assertUndiciMajorInvariant('6.28.0', '7.24.4')).toThrow(/6\.28\.0/);
    expect(() => assertUndiciMajorInvariant('6.28.0', '7.24.4')).toThrow(/7\.24\.4/);
  });

  it('throws when userland major is ahead of bundled (Dependabot bump without node base-image update)', () => {
    expect(() => assertUndiciMajorInvariant('8.9.0', '6.21.0')).toThrow(/undici major-version skew/);
    expect(() => assertUndiciMajorInvariant('8.9.0', '6.21.0')).toThrow(/8\.9\.0/);
    expect(() => assertUndiciMajorInvariant('8.9.0', '6.21.0')).toThrow(/6\.21\.0/);
  });

  it('passes when bundled version is undefined (node <22 without bundled undici)', () => {
    expect(() => assertUndiciMajorInvariant('6.28.0', undefined)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// t/4201 — a cache-hit start must load repoTree, so listings and /healthz never hit the Contents API.
// Before the fix, every listDirectory after a cache-hit start called GitHub (the 10-13 outage, t/4176).
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — cache-hit start loads the repo tree (t/4201)', () => {
  const manifest = {
    version: 1, generation: 1, lastCommitSha: MAIN_SHA, lastUpdated: '2026-10-15T00:00:00Z',
    files: {
      'taxonomy/accelerationist.json': { sha: 'm-blob-acc', etag: '', cachedAt: '2026-10-15T00:00:00Z' },
      'taxonomy/skeptic.json': { sha: 'm-blob-skp', etag: '', cachedAt: '2026-10-15T00:00:00Z' },
    },
  };

  async function withManifestOnDisk<T>(fn: () => Promise<T>): Promise<T> {
    const fsp = (await import('fs/promises')).default as unknown as { readFile: ReturnType<typeof vi.fn> };
    fsp.readFile.mockImplementation(async (p: string) => {
      if (String(p).endsWith('manifest.json')) return JSON.stringify(manifest);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    try { return await fn(); } finally {
      fsp.readFile.mockImplementation(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    }
  }

  const contentsCalls = () => fetchCalls.filter(c => c.method === 'GET' && c.url.includes('/contents/'));

  it('loads the tree with one fetch, then N listings make zero Contents API calls', async () => {
    await withManifestOnDisk(async () => {
      const backend = await createBackend();
      const before = contentsCalls().length;
      for (let i = 0; i < 10; i++) {
        const entries = await backend.listDirectory('/taxonomy');
        expect(entries).toEqual(expect.arrayContaining(['nodes.json', 'edges.json']));
      }
      expect(contentsCalls().length - before).toBe(0);
      expect(fetchCalls.filter(c => c.url.includes('/git/trees/')).length).toBe(1);
      backend.shutdown();
    });
  });

  it('seeds the tree from the manifest (with a warn) when the tree fetch fails, and still lists without GitHub', async () => {
    await withManifestOnDisk(async () => {
      apiHandlers.push((url, init) =>
        (init.method ?? 'GET') === 'GET' && /\/git\/commits\/[a-f0-9]/.test(url) ? { status: 500, body: { message: 'boom' } } : (undefined as never));
      const recorder = createTestRecorder();
      const backend = await createBackend(recorder);
      const before = contentsCalls().length;
      const entries = await backend.listDirectory('/taxonomy');
      expect(entries).toEqual(expect.arrayContaining(['accelerationist.json', 'skeptic.json']));
      expect(contentsCalls().length - before).toBe(0);
      expect(recorder.events.some(e => e.level === 'warn' && String(e.message).includes('seeded repoTree from the manifest'))).toBe(true);
      backend.shutdown();
    });
  });
});
