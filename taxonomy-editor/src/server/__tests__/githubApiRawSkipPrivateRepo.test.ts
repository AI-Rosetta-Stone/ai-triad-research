// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/497 (TL p/50#134, Security t/497#2): the raw.githubusercontent.com fetch is unauthenticated by design,
 * so a private data repo answers 404 to every request and each read then falls back to REST. The backend
 * now reads the repo's visibility (GET /repos/{repo}, installation token, api.github.com only) and skips
 * raw when the repo is not public. Security's conditions are each tested here: a TTL, a re-read after an
 * in-tree raw 404, "unknown means try raw as today", and no Authorization header on any raw request.
 * Every filesystem target is inside an fs.mkdtemp directory.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';
import { log } from '../logger.js';

vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/testrepo', token: 'SECRET-TOKEN', mode: 'app' }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getDefaultBranch: vi.fn().mockReturnValue('main'),
  invalidateCredentials: vi.fn(),
}));

const HEAD = '2222222222222222222222222222222222222222';
const FILE = 'taxonomy/a.json';
const BODY = '{"a":1}';

type Resp = { ok: boolean; status?: number; data?: unknown; etag?: string };
type Internals = {
  manifest: { version: number; generation: number; lastCommitSha: string; lastUpdated: string; files: Record<string, unknown> } | null;
  rest: { isTripped: () => boolean; request: (creds: unknown, method: string, p: string) => Promise<Resp> };
  getCredsCached: () => Promise<{ repo: string; token: string; mode: 'app' } | null>;
  repoTree: Map<string, unknown>;
  readFileFromMainCache: (repoPath: string, ref: string, optional: boolean | undefined, strict?: boolean) => Promise<string | null>;
  refreshRepoVisibility: (trigger: 'startup' | 'ttl' | 'raw-404') => Promise<void>;
  repoVisibility: { isPublic: boolean; visibility: string; checkedAt: number } | null;
  repoVisibilityInFlight: Promise<void> | null;
  repoVisibilityLastAttemptAt: number;
  getRawFallbackStats: () => { counts: Record<string, number>; disabled: boolean };
};

/** What GET /repos/{repo} answers: a visibility, or null for a failed read. */
let repoAnswer: { visibility?: string; private?: boolean } | null;
let rawStatus: 200 | 404;
let repoCalls: number;
let restContentCalls: number;
let rawCalls: Array<{ url: string; headers: Record<string, string> }>;
let tmp: string;
let cacheDir: string;
const originalFetch = globalThis.fetch;

async function router(_creds: unknown, _method: string, p: string): Promise<Resp> {
  if (p === '/repos/testowner/testrepo') {
    repoCalls++;
    return repoAnswer ? { ok: true, status: 200, data: repoAnswer } : { ok: false, status: 404, data: {} };
  }
  if (p.startsWith(`/repos/testowner/testrepo/contents/${FILE}`)) {
    restContentCalls++;
    return { ok: true, status: 200, etag: '"e"', data: { type: 'file', encoding: 'base64', sha: 'BLOB', size: BODY.length, content: Buffer.from(BODY).toString('base64') } };
  }
  return { ok: false, status: 404, data: {} };
}

/** Only raw.githubusercontent.com goes through global fetch here; REST is the fake client above. */
function rawFetch(input: unknown, init?: { headers?: Record<string, string> }): Promise<Response> {
  rawCalls.push({ url: String(input), headers: { ...(init?.headers ?? {}) } });
  return Promise.resolve(rawStatus === 200 ? new Response(BODY, { status: 200 }) : new Response('404: Not Found', { status: 404 }));
}

beforeAll(async () => {
  await import('../storage/githubAPIBackend');
}, 60_000);

beforeEach(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gh-raw-skip-')));
  cacheDir = path.join(tmp, 'cache');
  await fsp.mkdir(cacheDir, { recursive: true });
  repoAnswer = { visibility: 'public', private: false };
  rawStatus = 200;
  repoCalls = 0;
  restContentCalls = 0;
  rawCalls = [];
  globalThis.fetch = rawFetch as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** A backend past start-up: a commit to pin raw to, the file in the tree, nothing in the disk cache. */
async function makeBackend(): Promise<Internals> {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const b = new GitHubAPIBackend({ cacheDir, pollIntervalMs: 999_999_999, coherencyProbeRate: 0 }) as unknown as Internals;
  b.rest = { isTripped: () => false, request: router };
  b.getCredsCached = async () => ({ repo: 'testowner/testrepo', token: 'SECRET-TOKEN', mode: 'app' });
  b.manifest = { version: 1, generation: 1, lastCommitSha: HEAD, lastUpdated: new Date().toISOString(), files: {} };
  b.repoTree.set(FILE, { path: FILE, mode: '100644', type: 'blob', sha: 'BLOB' });
  return b;
}

/** A fresh read each time: drop the manifest entry so the disk cache is not consulted. */
async function read(b: Internals): Promise<string | null> {
  if (b.manifest) b.manifest.files = {};
  return b.readFileFromMainCache(FILE, 'main', false, false);
}

function expectNoAuthOnRaw(): void {
  for (const call of rawCalls) {
    const names = Object.keys(call.headers).map(h => h.toLowerCase());
    expect(names).not.toContain('authorization');
    expect(JSON.stringify(call)).not.toContain('SECRET-TOKEN');
  }
}

describe.skipIf(!isUndiciMajorAlignedWithRuntime())('the raw fetch is skipped for a data repo that is not public (t/497)', () => {
  it.each([['private'], ['internal']])('visibility %s: no raw request is made, the read comes from REST, and the skip is logged once', async (visibility) => {
    const warn = vi.spyOn(log.github, 'warn');
    repoAnswer = { visibility, private: true };
    rawStatus = 404;
    const b = await makeBackend();
    await b.refreshRepoVisibility('startup');

    await expect(read(b)).resolves.toBe(BODY);
    await expect(read(b)).resolves.toBe(BODY);
    await expect(read(b)).resolves.toBe(BODY);

    expect(rawCalls).toHaveLength(0);
    expect(restContentCalls).toBe(3);
    expect(repoCalls).toBe(1); // one visibility read, not one per file read
    expect(b.getRawFallbackStats().counts.private_repo).toBe(3);
    expect(b.getRawFallbackStats().disabled).toBe(false);
    const skipLines = warn.mock.calls.filter(c => String(c[1]).includes('raw fetch is skipped'));
    expect(skipLines).toHaveLength(1);
    expect(warn.mock.calls.some(c => String(c[1]).includes('falling back to REST'))).toBe(false);
  });

  it('a public repo is unchanged: the read comes from raw, with no REST call and no Authorization header', async () => {
    const b = await makeBackend();
    await b.refreshRepoVisibility('startup');
    await expect(read(b)).resolves.toBe(BODY);
    expect(rawCalls).toHaveLength(1);
    expect(rawCalls[0].url).toBe(`https://raw.githubusercontent.com/testowner/testrepo/${HEAD}/${FILE}`);
    expect(restContentCalls).toBe(0);
    expectNoAuthOnRaw();
  });

  it('an older API answer with only `private: false` counts as public', async () => {
    repoAnswer = { private: false };
    const b = await makeBackend();
    await b.refreshRepoVisibility('startup');
    expect(b.repoVisibility).toMatchObject({ isPublic: true, visibility: 'public' });
    await read(b);
    expect(rawCalls).toHaveLength(1);
  });

  describe('unknown means "try raw as today" (Security condition 1)', () => {
    it('a failed visibility read never disables raw: the raw request is still made', async () => {
      repoAnswer = null;
      rawStatus = 404;
      const b = await makeBackend();
      await b.refreshRepoVisibility('startup');
      expect(b.repoVisibility).toBeNull();
      await expect(read(b)).resolves.toBe(BODY); // raw 404 in tree, then REST, as before t/497
      expect(rawCalls).toHaveLength(1);
      expectNoAuthOnRaw();
    });

    it('with no visibility read at all, raw is tried', async () => {
      const b = await makeBackend();
      await expect(read(b)).resolves.toBe(BODY);
      expect(rawCalls).toHaveLength(1);
      expect(repoCalls).toBe(0);
    });
  });

  it('TTL (Security condition 2): an answer older than an hour is read again before it is used', async () => {
    repoAnswer = { visibility: 'private', private: true };
    const b = await makeBackend();
    await b.refreshRepoVisibility('startup');
    await read(b);
    expect(rawCalls).toHaveLength(0);

    // The repo was made public, and the cached answer is now older than the TTL.
    repoAnswer = { visibility: 'public', private: false };
    b.repoVisibility = { ...b.repoVisibility!, checkedAt: Date.now() - 61 * 60_000 };
    await expect(read(b)).resolves.toBe(BODY);
    expect(repoCalls).toBe(2);
    expect(rawCalls).toHaveLength(1);

    // A fresh answer is not read again.
    await read(b);
    expect(repoCalls).toBe(2);
  });

  it('re-read after an in-tree raw 404 (Security condition 2): a repo that turned private stops being asked on raw', async () => {
    const b = await makeBackend();
    await b.refreshRepoVisibility('startup'); // public
    b.repoVisibilityLastAttemptAt = 0; // the start-up read was more than a minute ago

    // The repo is made private: raw now 404s for a path that is in the tree.
    repoAnswer = { visibility: 'private', private: true };
    rawStatus = 404;
    await expect(read(b)).resolves.toBe(BODY); // this read falls back to REST
    expect(rawCalls).toHaveLength(1);
    await b.repoVisibilityInFlight; // the background re-read
    expect(repoCalls).toBe(2);
    expect(b.repoVisibility?.isPublic).toBe(false);

    await expect(read(b)).resolves.toBe(BODY);
    expect(rawCalls).toHaveLength(1); // no second raw request
  });

  it('the re-read after a raw 404 is rate-limited: many 404s in a minute cause one visibility read', async () => {
    rawStatus = 404;
    const b = await makeBackend();
    await b.refreshRepoVisibility('startup'); // public, just now
    for (let i = 0; i < 5; i++) await read(b);
    await b.repoVisibilityInFlight;
    expect(rawCalls).toHaveLength(5);
    expect(repoCalls).toBe(1); // only the start-up read: the last attempt was under a minute ago
  });

  it('no raw request ever carries an Authorization header or the token (Security condition, t/497#2)', async () => {
    const b = await makeBackend();
    for (const answer of [{ visibility: 'public' }, null]) {
      repoAnswer = answer;
      b.repoVisibilityLastAttemptAt = 0;
      await b.refreshRepoVisibility('startup');
      for (const status of [200, 404] as const) {
        rawStatus = status;
        await read(b);
      }
    }
    expect(rawCalls.length).toBeGreaterThanOrEqual(3);
    expectNoAuthOnRaw();
  });
});
