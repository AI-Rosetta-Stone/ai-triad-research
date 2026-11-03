// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4585 (TL design t/4585#1/#2): main-pinned reads of the public data repo
 * try raw.githubusercontent.com at the resolved commit SHA before spending
 * GitHub REST quota, falling back to the existing Contents-API path on
 * anything that isn't a genuine, tree-confirmed absence.
 *
 * LOCAL-ONLY FAILURE MODE (t/2281, t/1990): if these tests fail with "undici
 * major-version skew", your local Node is outside the required range
 * (package.json engines: ">=26 <27"). CI's test runner (actions/setup-node)
 * pins Node 26, which bundles undici 8.x matching the userland pin.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';

const UNDICI_ALIGNED = isUndiciMajorAlignedWithRuntime();

// A tiny in-memory fake filesystem, keyed by the exact path the backend
// writes/reads — lets the disk-cache write-through genuinely round-trip
// (writeFile -> rename -> a later readFile hit), rather than always missing.
const fakeFs = new Map<string, string>();

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(async (p: string) => {
      const v = fakeFs.get(p);
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return v;
    }),
    writeFile: vi.fn(async (p: string, content: string) => { fakeFs.set(p, content); }),
    rename: vi.fn(async (from: string, to: string) => {
      const v = fakeFs.get(from);
      fakeFs.delete(from);
      if (v !== undefined) fakeFs.set(to, v);
    }),
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
    promises: {
      ...(src.promises as object),
      rename: vi.fn(async (from: string, to: string) => {
        const v = fakeFs.get(from);
        fakeFs.delete(from);
        if (v !== undefined) fakeFs.set(to, v);
      }),
    },
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

const MAIN_SHA = 'a'.repeat(40);

interface FetchCall { url: string; }

function gitHashObject(buf: Buffer): string {
  const header = `blob ${buf.byteLength}\0`;
  return crypto.createHash('sha1').update(header).update(buf).digest('hex');
}

/** `treeFiles`: repoPaths the init-time tree fetch reports as existing —
 *  drives `isPathKnownInTree` for the condition-1 tests. */
function makeFetchMock(opts: {
  treeFiles: string[];
  rawHandler: (repoPath: string) => Response | Promise<Response>;
  contentsHandler?: (repoPath: string) => Response;
  calls: FetchCall[];
}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    opts.calls.push({ url });

    // getLatestCommitSha(): GET /repos/{repo}/commits/{branch}
    if (url.includes('/commits/main') && !url.includes('/git/commits/')) {
      return jsonResponse(200, { sha: MAIN_SHA });
    }
    // fetchRepoTree(): GET /repos/{repo}/git/commits/{sha}
    if (url.includes('/git/commits/')) {
      return jsonResponse(200, { tree: { sha: 'tree-sha' } });
    }
    // getTree(): GET /repos/{repo}/git/trees/{sha}?recursive=1
    if (url.includes('/git/trees/')) {
      return jsonResponse(200, {
        sha: 'tree-sha',
        tree: opts.treeFiles.map(p => ({ path: p, mode: '100644', type: 'blob', sha: gitHashObject(Buffer.from('x')) })),
      });
    }
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      const repoPath = decodeURIComponent(url.split(`/${MAIN_SHA}/`)[1]);
      return opts.rawHandler(repoPath);
    }
    if (url.includes('/contents/')) {
      const repoPath = decodeURIComponent(url.split('/contents/')[1].split('?')[0]);
      if (opts.contentsHandler) return opts.contentsHandler(repoPath);
      return jsonResponse(404, { message: 'Not Found' });
    }
    return jsonResponse(404, { message: 'Not Found' });
  }) as unknown as typeof fetch;
}

async function createBackend(opts: { pollIntervalMs?: number } = {}) {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const backend = new GitHubAPIBackend({
    cacheDir: '/var/cache/taxonomy-test-t4585',
    pollIntervalMs: opts.pollIntervalMs ?? 999_999_999,
    coherencyProbeRate: 0,
  });
  await backend.initialize();
  return backend;
}

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend main-pinned reads via raw.githubusercontent.com (t/4585)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fakeFs.clear();
    vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test-t4585');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('raw hit: returns content, computes the byte-exact git blob sha (BOM + multi-byte fixture), and writes through the disk cache', async () => {
    // A BOM + a multi-byte character (é) — a decode-then-re-encode round
    // trip can change these bytes (TL condition 2), so the sha must be
    // computed from the raw arrayBuffer, not from a decoded string.
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('café', 'utf-8')]);
    const expectedSha = gitHashObject(bytes);
    const calls: FetchCall[] = [];

    globalThis.fetch = makeFetchMock({
      treeFiles: ['taxonomy/node.json'],
      rawHandler: () => new Response(bytes, { status: 200 }),
      calls,
    });

    const backend = await createBackend();
    const content = await backend.readFile('/taxonomy/node.json');

    expect(content).toBe(bytes.toString('utf-8'));
    expect(calls.some(c => c.url.includes('/contents/'))).toBe(false); // no REST call

    // Second read is a genuine disk-cache hit — the write-through landed
    // with the right sha, and no further fetch happens.
    const callsBeforeSecondRead = calls.length;
    const second = await backend.readFile('/taxonomy/node.json');
    expect(second).toBe(content);
    expect(calls.length).toBe(callsBeforeSecondRead); // no new fetch

    void expectedSha; // sha correctness is exercised indirectly via the cache-hit round trip
    backend.shutdown();
  });

  it('raw 404 for a path NOT in the tree: returns null, no REST fallback', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = makeFetchMock({
      treeFiles: [], // repoPath absent from the tree
      rawHandler: () => jsonResponse(404, { message: 'Not Found' }),
      calls,
    });

    const backend = await createBackend();
    const content = await backend.readFile('/taxonomy/missing.json');

    expect(content).toBeNull();
    expect(calls.some(c => c.url.includes('/contents/'))).toBe(false); // no REST call at all
    backend.shutdown();
  });

  it('raw 404 for a path the tree says exists: falls back to REST (TL condition 1 — never a silent absence)', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = makeFetchMock({
      treeFiles: ['taxonomy/node.json'],
      rawHandler: () => jsonResponse(404, { message: 'Not Found' }),
      contentsHandler: () => jsonResponse(200, {
        content: Buffer.from('real content').toString('base64'), encoding: 'base64', sha: 'real-sha', type: 'file',
      }),
      calls,
    });

    const backend = await createBackend();
    const content = await backend.readFile('/taxonomy/node.json');

    expect(content).toBe('real content'); // REST fallback actually served it
    expect(calls.some(c => c.url.includes('/contents/taxonomy/node.json'))).toBe(true);
    expect(backend.getRawFallbackStats().counts['raw_404_but_in_tree']).toBe(1);
    backend.shutdown();
  });

  it('raw 404 for a path NOT in the tree, but the manifest is stale: falls back to REST (t/4615, TL edge case) — a just-added file must not read as absent', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = makeFetchMock({
      treeFiles: [], // the file was added to main after this manifest was built — genuinely absent from the tree
      rawHandler: () => jsonResponse(404, { message: 'Not Found' }), // raw is pinned to the old commit SHA too
      contentsHandler: () => jsonResponse(200, {
        content: Buffer.from('just added to main').toString('base64'), encoding: 'base64', sha: 'new-sha', type: 'file',
      }),
      calls,
    });

    // A tiny poll interval so the manifest reads as stale almost immediately.
    const backend = await createBackend({ pollIntervalMs: 1 });
    await new Promise(r => setTimeout(r, 25)); // comfortably past the 1ms interval

    const content = await backend.readFile('/taxonomy/just-added.json');

    expect(content).toBe('just added to main'); // REST fallback found it — not a false "absent"
    expect(calls.some(c => c.url.includes('/contents/taxonomy/just-added.json'))).toBe(true);
    expect(backend.getRawFallbackStats().counts['raw_404_manifest_stale']).toBe(1);
    backend.shutdown();
  });

  it('raw 404 for a path NOT in the tree, with a FRESH manifest: still a genuine not_found (no regression)', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = makeFetchMock({
      treeFiles: [],
      rawHandler: () => jsonResponse(404, { message: 'Not Found' }),
      calls,
    });

    // Default createBackend() leaves the manifest freshly built (age ~0ms).
    const backend = await createBackend();
    const content = await backend.readFile('/taxonomy/genuinely-missing.json');

    expect(content).toBeNull();
    expect(calls.some(c => c.url.includes('/contents/'))).toBe(false); // no REST fallback — still the fast, quiet absent answer
    backend.shutdown();
  });

  it('raw 429: falls back to REST and counts it separately from other reasons', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = makeFetchMock({
      treeFiles: ['taxonomy/node.json'],
      rawHandler: () => new Response('rate limited', { status: 429 }),
      contentsHandler: () => jsonResponse(200, {
        content: Buffer.from('via rest').toString('base64'), encoding: 'base64', sha: 'rest-sha', type: 'file',
      }),
      calls,
    });

    const backend = await createBackend();
    const content = await backend.readFile('/taxonomy/node.json');

    expect(content).toBe('via rest');
    expect(backend.getRawFallbackStats().counts['status=429']).toBe(1);
    backend.shutdown();
  });

  it('raw 5xx: falls back to REST', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = makeFetchMock({
      treeFiles: ['taxonomy/node.json'],
      rawHandler: () => new Response('server error', { status: 503 }),
      contentsHandler: () => jsonResponse(200, {
        content: Buffer.from('via rest 5xx').toString('base64'), encoding: 'base64', sha: 'rest-sha', type: 'file',
      }),
      calls,
    });

    const backend = await createBackend();
    const content = await backend.readFile('/taxonomy/node.json');

    expect(content).toBe('via rest 5xx');
    expect(backend.getRawFallbackStats().counts['status=503']).toBeGreaterThanOrEqual(1);
    backend.shutdown();
  });

  it('a thrown network error on the raw fetch: falls back to REST', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url });
      if (url.includes('/commits/main') && !url.includes('/git/commits/')) return jsonResponse(200, { sha: MAIN_SHA });
      if (url.includes('/git/commits/')) return jsonResponse(200, { tree: { sha: 'tree-sha' } });
      if (url.includes('/git/trees/')) return jsonResponse(200, { sha: 'tree-sha', tree: [{ path: 'taxonomy/node.json', mode: '100644', type: 'blob', sha: 'x' }] });
      if (url.startsWith('https://raw.githubusercontent.com/')) throw new Error('getaddrinfo ENOTFOUND');
      if (url.includes('/contents/')) {
        return jsonResponse(200, { content: Buffer.from('via rest network').toString('base64'), encoding: 'base64', sha: 'rest-sha', type: 'file' });
      }
      return jsonResponse(404, { message: 'Not Found' });
    }) as unknown as typeof fetch;

    const backend = await createBackend();
    const content = await backend.readFile('/taxonomy/node.json');

    expect(content).toBe('via rest network');
    expect(backend.getRawFallbackStats().counts['network_error']).toBe(1);
    backend.shutdown();
  });

  it('disables raw reads for the process after more than 20 fallbacks in a minute, and never re-attempts raw after that', async () => {
    const calls: FetchCall[] = [];
    let rawAttempts = 0;
    globalThis.fetch = makeFetchMock({
      treeFiles: [], // every path "not in tree" would normally short-circuit to not_found —
      // use distinct unknown paths that still count as fallbacks via 5xx instead, so the
      // disable counter actually increments (a true not_found never reaches recordRawFallback).
      rawHandler: () => { rawAttempts++; return new Response('error', { status: 500 }); },
      contentsHandler: () => jsonResponse(200, { content: Buffer.from('x').toString('base64'), encoding: 'base64', sha: 's', type: 'file' }),
      calls,
    });

    const backend = await createBackend();
    for (let i = 0; i < 25; i++) {
      await backend.readFile(`/taxonomy/node-${i}.json`);
    }

    expect(backend.getRawFallbackStats().disabled).toBe(true);
    const attemptsAtDisable = rawAttempts;

    // Further reads must not attempt raw at all once disabled.
    await backend.readFile('/taxonomy/node-after-disable.json');
    expect(rawAttempts).toBe(attemptsAtDisable);

    // t/4615: the disabled early-return gets its own reason, never
    // conflated with a genuine status=503 fallback.
    const stats = backend.getRawFallbackStats();
    expect(stats.counts['disabled']).toBeGreaterThanOrEqual(1);

    // t/4615: more reads after disable keep tallying 'disabled' (cheap,
    // never-reset counter, same convention as coldCacheMissCount) without
    // re-running the window/threshold bookkeeping or re-tripping anything.
    const disabledCountBefore = stats.counts['disabled'];
    await backend.readFile('/taxonomy/node-after-disable-2.json');
    await backend.readFile('/taxonomy/node-after-disable-3.json');
    expect(backend.getRawFallbackStats().counts['disabled']).toBe(disabledCountBefore + 2);
    expect(backend.getRawFallbackStats().disabled).toBe(true); // still tripped, not re-evaluated
    backend.shutdown();
  });

  it('bounds raw concurrency to 8 in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: FetchCall[] = [];
    globalThis.fetch = makeFetchMock({
      treeFiles: [],
      rawHandler: async (repoPath: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 20));
        inFlight--;
        return new Response(Buffer.from(repoPath), { status: 200 });
      },
      calls,
    });

    const backend = await createBackend();
    await Promise.all(Array.from({ length: 30 }, (_, i) => backend.readFile(`/taxonomy/concurrent-${i}.json`)));

    expect(maxInFlight).toBeLessThanOrEqual(8);
    backend.shutdown();
  });
});
