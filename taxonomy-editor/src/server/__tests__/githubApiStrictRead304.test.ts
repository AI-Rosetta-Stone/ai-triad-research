// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/478: a strict main read (readFileStrict) skips the disk cache, but the REST request still carries
 * the manifest's ETag. GitHub then answers 304 with no body, and the read must not turn that into
 * "file absent". Seen on staging, where the data repo is private: the unauthenticated raw fetch 404s,
 * the read falls back to REST, and entities.json read as absent on every attempt.
 * The real GitHubRestClient is used, with global fetch stubbed. Filesystem targets are in an mkdtemp dir.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';
import { log } from '../logger.js';

vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/private-data', token: 't', mode: 'app' }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/private-data'),
  getDefaultBranch: vi.fn().mockReturnValue('staging'),
  invalidateCredentials: vi.fn(),
}));

const HEAD = '2222222222222222222222222222222222222222';
const FILE = 'taxonomy/Origin/entities.json';
const BODY = JSON.stringify({ entities: [{ id: 'ent-001' }] });
const ETAG = '"etag-entities"';

type Internals = {
  manifest: { version: number; generation: number; lastCommitSha: string; lastUpdated: string; files: Record<string, { sha: string; etag: string; cachedAt: string }> } | null;
  getCredsCached: () => Promise<{ repo: string; token: string; mode: 'app' } | null>;
  repoTree: Map<string, unknown>;
  readFileFromMainCache: (repoPath: string, ref: string, optional: boolean | undefined, strict?: boolean) => Promise<string | null>;
  baseBranch: string;
  fetchBinaryFileFromGitHub: (repoPath: string, ref: string) => Promise<{ content: Buffer; sha: string; etag: string } | null>;
};

let tmp: string;
let cacheDir: string;
let calls: Array<{ url: string; ifNoneMatch: string | null; authorization: string | null }>;
const originalFetch = globalThis.fetch;

/** A private repo: raw 404s without a token; the contents API honours If-None-Match. */
function privateRepoFetch(input: unknown, init?: { headers?: Record<string, string> }): Promise<Response> {
  const url = String(input);
  const headers = init?.headers ?? {};
  const ifNoneMatch = headers['If-None-Match'] ?? null;
  calls.push({ url, ifNoneMatch, authorization: headers.Authorization ?? null });
  if (url.startsWith('https://raw.githubusercontent.com/')) {
    return Promise.resolve(new Response('404: Not Found', { status: 404 }));
  }
  if (url.includes(`/contents/${FILE}`)) {
    if (ifNoneMatch === ETAG) return Promise.resolve(new Response(null, { status: 304, headers: { etag: ETAG } }));
    const payload = { type: 'file', encoding: 'base64', size: BODY.length, sha: 'BLOBSHA', content: Buffer.from(BODY).toString('base64') };
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { etag: ETAG, 'content-type': 'application/json' } }));
  }
  return Promise.resolve(new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }));
}

beforeAll(async () => {
  await import('../storage/githubAPIBackend');
}, 60_000);

beforeEach(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gh-strict-304-')));
  cacheDir = path.join(tmp, 'cache');
  await fsp.mkdir(cacheDir, { recursive: true });
  calls = [];
  vi.stubEnv('GITHUB_BRANCH', 'staging');
  globalThis.fetch = privateRepoFetch as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** A backend past start-up: the tree knows the file, and the manifest may hold its ETag from an earlier read. */
async function makeBackend(withEtag: boolean): Promise<Internals> {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const b = new GitHubAPIBackend({ cacheDir, pollIntervalMs: 999_999_999, coherencyProbeRate: 0 }) as unknown as Internals;
  b.getCredsCached = async () => ({ repo: 'testowner/private-data', token: 't', mode: 'app' });
  b.manifest = {
    version: 1, generation: 1, lastCommitSha: HEAD, lastUpdated: new Date().toISOString(),
    files: withEtag ? { [FILE]: { sha: 'BLOBSHA', etag: ETAG, cachedAt: new Date().toISOString() } } : {},
  };
  b.repoTree.set(FILE, { path: FILE, mode: '100644', type: 'blob', sha: 'BLOBSHA' });
  return b;
}

const rawCalls = () => calls.filter(c => c.url.startsWith('https://raw.githubusercontent.com/'));
const restCalls = () => calls.filter(c => c.url.includes('/contents/'));
const msgs = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(c => String(c[1]));

describe.skipIf(!isUndiciMajorAlignedWithRuntime())('a 304 is never read as an absent file (t/478)', () => {
  describe('strict main read on a private repo', () => {
    it('control: with no ETag in the manifest, the REST fallback returns the file', async () => {
      const b = await makeBackend(false);
      expect(b.baseBranch).toBe('staging');
      await expect(b.readFileFromMainCache(FILE, b.baseBranch, false, true)).resolves.toBe(BODY);
      // The raw fetch carries no token; the REST call does, and names the ref.
      expect(rawCalls()[0]?.authorization).toBeNull();
      expect(restCalls()).toHaveLength(1);
      expect(restCalls()[0].authorization).toBe('Bearer t');
      expect(restCalls()[0].url).toContain('?ref=staging');
      expect(restCalls()[0].ifNoneMatch).toBeNull();
    });

    it('with an ETag in the manifest, the file is returned and no If-None-Match is sent', async () => {
      const info = vi.spyOn(log.github, 'info');
      const b = await makeBackend(true);
      await expect(b.readFileFromMainCache(FILE, b.baseBranch, false, true)).resolves.toBe(BODY);
      expect(restCalls()).toHaveLength(1);
      expect(restCalls()[0].ifNoneMatch).toBeNull();
      // The line the next staging boot is read for: it says an ETag was there and was not sent.
      const line = info.mock.calls.find(c => String(c[1]).includes('strict read goes to REST without If-None-Match'));
      expect(line?.[0]).toMatchObject({ path: FILE, ref: 'staging', manifestEtagPresent: true });
    });

    it('the second strict read returns the file too (the first one stores the ETag)', async () => {
      const b = await makeBackend(false);
      await expect(b.readFileFromMainCache(FILE, b.baseBranch, false, true)).resolves.toBe(BODY);
      expect(b.manifest?.files[FILE]?.etag).toBe(ETAG);
      await expect(b.readFileFromMainCache(FILE, b.baseBranch, false, true)).resolves.toBe(BODY);
      expect(restCalls().every(c => c.ifNoneMatch === null)).toBe(true);
    });
  });

  describe('guard: a 304 with no cached body to serve', () => {
    it('a non-strict read whose cache file is gone retries once without the ETag, with a WARN naming path and ref', async () => {
      const warn = vi.spyOn(log.github, 'warn');
      // The manifest has the ETag, but the cached file is not on disk: a cache miss with an ETag.
      const b = await makeBackend(true);
      await expect(b.readFileFromMainCache(FILE, b.baseBranch, false, false)).resolves.toBe(BODY);
      expect(restCalls().map(c => c.ifNoneMatch)).toEqual([ETAG, null]);
      const line = warn.mock.calls.find(c => String(c[1]).includes('304 with no cached body to serve'));
      expect(line?.[0]).toMatchObject({ path: FILE, ref: 'staging' });
    });

    it('a 304 that persists on the unconditional retry is a WARN, and a strict read throws transient instead of returning null', async () => {
      const warn = vi.spyOn(log.github, 'warn');
      globalThis.fetch = ((input: unknown, init?: { headers?: Record<string, string> }) => {
        const url = String(input);
        if (url.includes('/contents/')) {
          calls.push({ url, ifNoneMatch: init?.headers?.['If-None-Match'] ?? null, authorization: null });
          return Promise.resolve(new Response(null, { status: 304 }));
        }
        return privateRepoFetch(input, init);
      }) as unknown as typeof fetch;
      const b = await makeBackend(true);
      await expect(b.readFileFromMainCache(FILE, b.baseBranch, false, true)).rejects.toMatchObject({ kind: 'transient', reason: 'status=304' });
      expect(restCalls()).toHaveLength(2);
      expect(msgs(warn).some(m => m.includes('304 again on an unconditional retry'))).toBe(true);

      calls = [];
      await expect(b.readFileFromMainCache(FILE, b.baseBranch, false, false)).resolves.toBeNull();
      expect(restCalls().map(c => c.ifNoneMatch)).toEqual([ETAG, null]);
    });
  });

  describe('guard on the binary read', () => {
    it('a 304 on a binary cache miss retries once without the ETag and returns the bytes', async () => {
      const warn = vi.spyOn(log.github, 'warn');
      const b = await makeBackend(true);
      const got = await b.fetchBinaryFileFromGitHub(FILE, b.baseBranch);
      expect(got?.content.toString('utf-8')).toBe(BODY);
      expect(restCalls().map(c => c.ifNoneMatch)).toEqual([ETAG, null]);
      expect(msgs(warn).some(m => m.includes('fetchBinaryFileFromGitHub: 304 with no cached body to serve'))).toBe(true);
    });
  });

  describe('the ordinary cached path is unchanged', () => {
    it('a non-strict read with the file in the disk cache serves it with no GitHub call', async () => {
      const b = await makeBackend(true);
      await fsp.mkdir(path.join(cacheDir, 'taxonomy', 'Origin'), { recursive: true });
      await fsp.writeFile(path.join(cacheDir, FILE), 'CACHED-BODY');
      await expect(b.readFileFromMainCache(FILE, b.baseBranch, false, false)).resolves.toBe('CACHED-BODY');
      expect(calls).toHaveLength(0);
    });
  });
});
