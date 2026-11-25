// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/639 (incident t/629): a hosted profile whose Azure Blob backend is unset, or failed validation, refuses user content
 * with a 503 instead of falling back to the primary GitHubAPIBackend, which committed user-private files to the public
 * data repo. Security's condition: a real GitHubAPIBackend as the primary backend, and ZERO GitHub API calls for a dump
 * write and a users/<id>/ write, in both cases. Local / non-hosted mode keeps the fallback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';
import * as fileIO from '../storage/fileIO.js';

vi.mock('fs/promises', () => ({
  default: {
    realpath: vi.fn(async (p: string) => p),
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

vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/testrepo', token: 'test-token-abc123', mode: 'pat' as const }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getTokenExpiryMs: vi.fn().mockReturnValue(0),
}));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: vi.fn().mockReturnValue({ record: vi.fn() }),
  FlightRecorder: vi.fn(),
}));

/** Every GitHub API request the backend makes after setup. */
let githubCalls: Array<{ method: string; url: string }>;
const originalFetch = globalThis.fetch;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: new Headers({ 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '9999999999' }) });
}

async function makeGithubPrimary() {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const gh = new GitHubAPIBackend({
    cacheDir: `/var/cache/taxonomy-test-${Math.random()}`,
    recorder: { record: vi.fn(), flush: vi.fn(), toJSON: vi.fn().mockReturnValue([]), intern: vi.fn() } as never,
    pollIntervalMs: 999_999_999, coherencyProbeRate: 0,
  });
  await gh.initialize();
  githubCalls = []; // count only what happens after setup
  return gh;
}

const recorder = { record: vi.fn() } as never;

const BLOB_VARS = ['AZURE_STORAGE_ACCOUNT_URL', 'AZURE_USER_CONTENT_CONTAINER', 'AZURE_COMMUNITY_CONTAINER', 'AZURE_BRIEF_EXPORTS_CONTAINER', 'AZURE_ANALYTICS_CONTAINER'];

describe.skipIf(!isUndiciMajorAlignedWithRuntime())('hosted profile without a working Blob backend refuses user content (t/639)', () => {
  beforeEach(() => {
    vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test');
    for (const v of BLOB_VARS) vi.stubEnv(v, '');
    fileIO.resetUserContentBackendForTests();
    githubCalls = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      githubCalls.push({ method: init?.method ?? 'GET', url });
      if (url.includes('/git/refs/heads/')) return respond(200, { object: { sha: 'a'.repeat(40) } });
      if (url.includes('/git/trees/')) return respond(200, { sha: 't', truncated: false, tree: [] });
      return respond(404, { message: 'Not Found' });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    fileIO.resetUserContentBackendForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // The assertions live in this helper (vitest/expect-expect cannot see through it).
  async function expectRefusedWithZeroGithubCalls(): Promise<void> {
    const ucb = fileIO.getUserContentBackend();
    await expect(ucb.writeFile('flight-recorder/server-0b7c.jsonl', '{"key":"AIza..."}\n'))
      .rejects.toMatchObject({ httpStatus: 503, code: 'USER_CONTENT_STORE_UNAVAILABLE' });
    await expect(ucb.writeFile('users/u-123/debates/_index.json', '{}'))
      .rejects.toMatchObject({ httpStatus: 503, code: 'USER_CONTENT_STORE_UNAVAILABLE' });
    await expect(ucb.readFile('users/u-123/debates/_index.json')).rejects.toMatchObject({ httpStatus: 503 });
    expect(githubCalls).toEqual([]);
  }

  it('Blob unset (AZURE_STORAGE_ACCOUNT_URL empty), NODE_ENV=production: refused, zero GitHub calls', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    fileIO.setBackend(await makeGithubPrimary());
    const { initAzureBlobBackends } = await import('../storage/blobBackendInit.js');
    await initAzureBlobBackends(recorder);
    await expectRefusedWithZeroGithubCalls();
    expect.hasAssertions();
  });

  it('Blob invalid (account URL set, a container variable missing), NODE_ENV=production: refused, zero GitHub calls', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AZURE_STORAGE_ACCOUNT_URL', 'https://example.blob.core.windows.net');
    vi.stubEnv('AZURE_USER_CONTENT_CONTAINER', 'user-content'); // the other three stay missing
    fileIO.setBackend(await makeGithubPrimary());
    const { initAzureBlobBackends } = await import('../storage/blobBackendInit.js');
    await initAzureBlobBackends(recorder);
    await expectRefusedWithZeroGithubCalls();
    expect.hasAssertions();
  });

  it('a Container App (CONTAINER_APP_NAME set) counts as hosted even without NODE_ENV=production', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CONTAINER_APP_NAME', 'taxonomy-editor-staging');
    fileIO.setBackend(await makeGithubPrimary());
    await expectRefusedWithZeroGithubCalls();
    expect.hasAssertions();
  });

  it('not hosted: the local fallback to the primary backend is unchanged', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CONTAINER_APP_NAME', '');
    const gh = await makeGithubPrimary();
    fileIO.setBackend(gh);
    expect(fileIO.getUserContentBackend()).toBe(gh);
  });
});
