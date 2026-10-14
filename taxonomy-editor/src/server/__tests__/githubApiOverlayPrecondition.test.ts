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
  vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test');
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handleDefaultGithubApi(url, init?.method ?? 'GET');
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

// t/4187 (Rosetta Stone, p/775#18): the overlay fast path is where every
// hosted user save lands — baseSha must be enforced here too, or the fix
// protects no one on the web. 'blob1' is the repo-tree sha already in place
// for this path at initialize() — no GitHub call needed to resolve it.
describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — overlay baseSha precondition (t/4187)', () => {
  it('sequential saves succeed when each uses the prior write\'s returned version', async () => {
    const backend = await createBackend();
    backend.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

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
    await backend.writeFile('/taxonomy/nodes.json', '{"v": 1}', { baseSha: 'blob1' });

    const result = await backend.writeFile('/taxonomy/nodes.json', '{"v": 2}');

    expect(result.version).toBeTruthy();
    expect(recorder.events.find(e => e.type === 'storage.fallback')).toBeDefined();
    backend.shutdown();
  });
});
