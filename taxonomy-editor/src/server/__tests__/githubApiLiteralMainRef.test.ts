// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/505 (trace, TL p/50#144): callers pass the literal `ref: 'main'` to mean "the shared base data, not a
 * session branch". The backend compares that ref to its base branch. Where the base branch is not 'main'
 * (staging runs with GITHUB_BRANCH=staging), which branch does such a read hit?
 * Before the fix it hit the repository's default branch. The backend now maps that literal (exported as
 * BASE_BRANCH_REF) to its base branch at the read entry points.
 * This file records the URLs the real GitHubRestClient requests. Filesystem targets are in an mkdtemp dir.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';
import { BASE_BRANCH_REF } from '../storage/githubAPIBackend.js';
import { log } from '../logger.js';

vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/data-staging', token: 't', mode: 'app' }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/data-staging'),
  getDefaultBranch: vi.fn().mockReturnValue('staging'),
  invalidateCredentials: vi.fn(),
}));

const HEAD = '2222222222222222222222222222222222222222';
const FILE = 'taxonomy/Origin/edges.json';

type Internals = {
  manifest: { version: number; generation: number; lastCommitSha: string; lastUpdated: string; files: Record<string, unknown> } | null;
  getCredsCached: () => Promise<{ repo: string; token: string; mode: 'app' } | null>;
  repoTree: Map<string, unknown>;
  baseBranch: string;
  toRepoPath: (p: string) => string;
  readFile: (filePath: string, opts?: { ref?: string; optional?: boolean }) => Promise<string | null>;
  readBinaryFile: (filePath: string, opts?: { ref?: string }) => Promise<Buffer | null>;
  readFileAtRef: (repoPath: string, ref: string) => Promise<string | null>;
  compareBranches: (base: string, head: string) => Promise<unknown>;
  initialize: () => Promise<void>;
  shutdown: () => void;
};

let urls: string[];
let tmp: string;
let cacheDir: string;
const originalFetch = globalThis.fetch;

/** A repo whose default branch is `main` and which also has a `staging` branch. Records every URL. */
function recordingFetch(input: unknown): Promise<Response> {
  const url = String(input);
  urls.push(url);
  if (url.startsWith('https://raw.githubusercontent.com/')) return Promise.resolve(new Response('404: Not Found', { status: 404 }));
  if (url.includes('/contents/')) {
    const body = url.includes('ref=staging') ? 'FROM-STAGING' : 'FROM-DEFAULT-BRANCH';
    const payload = { type: 'file', encoding: 'base64', size: body.length, sha: 'BLOB', content: Buffer.from(body).toString('base64') };
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  return Promise.resolve(new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }));
}

beforeAll(async () => {
  await import('../storage/githubAPIBackend');
}, 60_000);

beforeEach(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gh-literal-main-')));
  cacheDir = path.join(tmp, 'cache');
  await fsp.mkdir(cacheDir, { recursive: true });
  urls = [];
  globalThis.fetch = recordingFetch as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function makeBackend(baseBranch: string | null): Promise<Internals> {
  if (baseBranch) vi.stubEnv('GITHUB_BRANCH', baseBranch);
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const b = new GitHubAPIBackend({ cacheDir, pollIntervalMs: 999_999_999, coherencyProbeRate: 0 }) as unknown as Internals;
  b.getCredsCached = async () => ({ repo: 'testowner/data-staging', token: 't', mode: 'app' });
  b.toRepoPath = () => FILE;
  b.manifest = { version: 1, generation: 1, lastCommitSha: HEAD, lastUpdated: new Date().toISOString(), files: {} };
  b.repoTree.set(FILE, { path: FILE, mode: '100644', type: 'blob', sha: 'BLOB' });
  return b;
}

const contentsUrls = () => urls.filter(u => u.includes('/contents/'));

describe.skipIf(!isUndiciMajorAlignedWithRuntime())("a read pinned with the literal ref 'main' reads the base branch (t/505)", () => {
  it("base branch 'staging': readFile(path, { ref: 'main' }) reads the staging branch", async () => {
    const b = await makeBackend('staging');
    expect(b.baseBranch).toBe('staging');
    await expect(b.readFile('/data/' + FILE, { ref: 'main' })).resolves.toBe('FROM-STAGING');
    expect(contentsUrls().every(u => u.includes('ref=staging'))).toBe(true);
  });

  it("base branch 'staging': readBinaryFile(path, { ref: 'main' }) reads the staging branch", async () => {
    const b = await makeBackend('staging');
    const got = await b.readBinaryFile('/data/' + FILE, { ref: 'main' });
    expect(got?.toString('utf-8')).toBe('FROM-STAGING');
    expect(contentsUrls().every(u => u.includes('ref=staging'))).toBe(true);
  });

  it("control, base branch 'main' (prod): the same read asks for no other branch", async () => {
    const b = await makeBackend(null);
    expect(b.baseBranch).toBe('main');
    await expect(b.readFile('/data/' + FILE, { ref: 'main' })).resolves.toBe('FROM-DEFAULT-BRANCH');
    expect(contentsUrls().some(u => u.includes('ref='))).toBe(false);
  });

  it("control: a read with no ref on base branch 'staging' reads the staging branch", async () => {
    const b = await makeBackend('staging');
    await expect(b.readFile('/data/' + FILE)).resolves.toBe('FROM-STAGING');
  });

  it("base branch 'staging': readFileAtRef(path, 'main') reads the staging branch", async () => {
    const b = await makeBackend('staging');
    await expect(b.readFileAtRef(FILE, BASE_BRANCH_REF)).resolves.toBe('FROM-STAGING');
    expect(contentsUrls().every(u => u.includes('ref=staging'))).toBe(true);
  });

  describe('a read that asks for a real session branch is unaffected (TL condition)', () => {
    const SESSION = 'api-session/alice';

    it.each([['staging'], [null]])('base branch %s: readFile(path, { ref: session }) asks GitHub for that session branch', async (base) => {
      const b = await makeBackend(base);
      await b.readFile('/data/' + FILE, { ref: SESSION, optional: true });
      const asked = contentsUrls();
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.every(u => u.includes(`ref=${encodeURIComponent(SESSION)}`))).toBe(true);
      expect(asked.some(u => u.includes('ref=staging'))).toBe(false);
    });

    it('a commit SHA passed to readFileAtRef is passed through as it is', async () => {
      const b = await makeBackend('staging');
      await b.readFileAtRef(FILE, HEAD);
      expect(contentsUrls().every(u => u.includes(`ref=${HEAD}`))).toBe(true);
    });
  });

  describe('the mapping is announced once at start-up (TL condition)', () => {
    const mappedLines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(c => String(c[1]).includes("reads pinned with ref 'main' are mapped"));

    it("base branch 'staging': initialize logs one info line naming the base branch", async () => {
      const info = vi.spyOn(log.storage, 'info');
      const b = await makeBackend('staging');
      await b.initialize().catch(() => undefined); // the stubbed GitHub has no commits; only the log matters here
      b.shutdown();
      expect(mappedLines(info)).toHaveLength(1);
      expect(mappedLines(info)[0][0]).toMatchObject({ baseBranch: 'staging' });
    });

    it("base branch 'main' (prod): no such line", async () => {
      const info = vi.spyOn(log.storage, 'info');
      const b = await makeBackend(null);
      await b.initialize().catch(() => undefined);
      b.shutdown();
      expect(mappedLines(info)).toHaveLength(0);
    });
  });

  describe('compareBranches maps the alias on either side (TL p/50#150)', () => {
    const SESSION = 'api-session/alice';
    const compareUrls = () => urls.filter(u => u.includes('/compare/'));

    it("base branch 'staging': compareBranches('main', session) compares against staging", async () => {
      const b = await makeBackend('staging');
      await b.compareBranches(BASE_BRANCH_REF, SESSION);
      expect(compareUrls()).toHaveLength(1);
      expect(compareUrls()[0]).toContain(`/compare/staging...${SESSION}`);
    });

    it("base branch 'staging': compareBranches(session, 'main') puts staging on the head side", async () => {
      const b = await makeBackend('staging');
      await b.compareBranches(SESSION, BASE_BRANCH_REF);
      expect(compareUrls()[0]).toContain(`/compare/${SESSION}...staging`);
    });

    it("base branch 'main' (prod): the comparison is against main, as before", async () => {
      const b = await makeBackend(null);
      await b.compareBranches(BASE_BRANCH_REF, SESSION);
      expect(compareUrls()[0]).toContain(`/compare/main...${SESSION}`);
    });

    it('two real refs are compared as given', async () => {
      const b = await makeBackend('staging');
      await b.compareBranches(HEAD, SESSION);
      expect(compareUrls()[0]).toContain(`/compare/${HEAD}...${SESSION}`);
    });
  });

  it("the constant is the literal callers already pass", () => {
    expect(BASE_BRANCH_REF).toBe('main');
  });
});
