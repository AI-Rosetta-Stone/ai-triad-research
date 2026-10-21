// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4286: a binary file too large for the Contents API's inline `content`
 * (>1MB) used to fall back to the Git Blobs API (`/git/blobs/{sha}`), which
 * always returns base64-in-JSON — a `res.text()` + `JSON.parse()` pass over
 * the whole body, THEN a second `Buffer.from(..., 'base64')` decode, both
 * synchronous and unyielded. Confirmed as the ~700ms-class event-loop block
 * on a cold read of the synthetic-embeddings .npy files (t/4286#25/#27/#28).
 *
 * Fix: re-request the same Contents endpoint with the raw media type instead
 * — GitHub serves raw bytes (no JSON, no base64) up to 100MB that way, read
 * with a single `res.arrayBuffer()`.
 *
 * Standalone from githubApi.test.ts (self-contained mocks) to stay under
 * that file's line budget rather than growing an already-near-limit file.
 *
 * LOCAL-ONLY FAILURE MODE (t/2281): if this fails with "undici major-version
 * skew", your local Node is outside the required range (package.json
 * engines: ">=22 <23"). CI uses node:22.23.2. Not a test or code defect.
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
  const patched = {
    ...src,
    promises: { ...(src.promises as object), rename: vi.fn().mockResolvedValue(undefined) },
  };
  return { ...patched, default: patched };
});

vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({
    repo: 'testowner/testrepo',
    token: 'test-token-abc123',
    mode: 'pat' as const,
  }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getTokenExpiryMs: vi.fn().mockReturnValue(0),
}));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: vi.fn().mockReturnValue(null),
  FlightRecorder: vi.fn(),
}));

const defaultRateLimitHeaders = {
  'x-ratelimit-remaining': '4999',
  'x-ratelimit-limit': '5000',
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: new Headers({ ...defaultRateLimitHeaders, ...headers }) });
}

function rawResponse(status: number, body: Buffer, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: new Headers({ ...defaultRateLimitHeaders, ...headers }) });
}

async function createBackend() {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const backend = new GitHubAPIBackend({
    cacheDir: '/var/cache/taxonomy-test',
    pollIntervalMs: 999_999_999,
    coherencyProbeRate: 0,
  });
  await backend.initialize();
  return backend;
}

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend.readBinaryFile — raw media type for large files (t/4286)', () => {
  const fetchCalls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchCalls.length = 0;
    vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('reads a large binary file via the raw Contents re-fetch, not the Git Blobs API', async () => {
    const binaryContent = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42, 0x13, 0x37]);
    let rawRequestSeen = false;

    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      fetchCalls.push({ url, method, headers });

      if (url.includes('/git/trees/')) return jsonResponse(200, { sha: 'tree-sha', tree: [] });
      if (url.includes('/git/refs/heads/')) return jsonResponse(200, { object: { sha: 'main-sha' } });
      if (url.includes('/contents/synthetic/embeddings_acc.npy')) {
        if (headers.Accept === 'application/vnd.github.raw+json') {
          rawRequestSeen = true;
          return rawResponse(200, binaryContent);
        }
        // A file too large for inline content: no `content`/`encoding`, just
        // enough metadata to drive the raw re-fetch.
        return jsonResponse(200, { sha: 'npy-blob-sha', size: binaryContent.length, type: 'file' });
      }
      return jsonResponse(404, { message: 'Not Found' });
    }) as unknown as typeof fetch;

    const backend = await createBackend();
    const result = await backend.readBinaryFile('/synthetic/embeddings_acc.npy');

    expect(rawRequestSeen).toBe(true);
    expect(result).not.toBeNull();
    expect(Buffer.compare(result!, binaryContent)).toBe(0); // byte-identical
    expect(fetchCalls.some(c => c.url.includes('/git/blobs/'))).toBe(false); // never the Blobs API

    backend.shutdown();
  });
});
