// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/434 regression tests: the four gaps left after #5169 (confineToDir on the cache writes).
 *  1. Cache reads and removes were unconfined.
 *  2. Absolute, drive-letter and UNC paths reached the repo path unchanged.
 *  3. `<root>-evil/x` shared the data root's name prefix and was rewritten into a repo path.
 *  4. NUL bytes passed through; backslash separators were not normalised.
 *
 * Every filesystem target is inside an fs.mkdtemp directory. The data root is `<tmp>/root` and the
 * cache is `<tmp>/root/cache`, so a `../` escape or an out-of-root file is always under `<tmp>`.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';

// t/577: pay githubAPIBackend's cold import here, not inside the first test's timeout. Under the pre-push hook's
// 8 workers the first test in this file timed out at 5-8 s although every test passes alone (TaxonomyServer p/52#36).
beforeAll(async () => { await import('../storage/githubAPIBackend'); }, 60_000);

vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/testrepo', token: 't', mode: 'pat' }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getDefaultBranch: vi.fn().mockReturnValue('main'),
  invalidateCredentials: vi.fn(),
}));

type Internals = {
  manifest: { version: number; generation: number; lastCommitSha: string; lastUpdated: string; files: Record<string, { sha: string; etag: string; cachedAt: string }> } | null;
  readFromDiskCache: (repoPath: string) => Promise<string | null>;
  readBinaryFromDiskCache: (repoPath: string) => Promise<Buffer | null>;
  removeFromDiskCache: (repoPath: string) => Promise<void>;
  toRepoPath: (filePath: string) => string;
};

let tmp: string;
let dataRoot: string;
let cacheDir: string;
let savedDataRoot: string | undefined;

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(() => undefined, (e: unknown) => (e as { code?: string }).code);
}

/** The `code` of the error a synchronous call throws, or undefined when it does not throw. */
function codeOfSync(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gh-gaps-')));
  dataRoot = path.join(tmp, 'root');
  cacheDir = path.join(dataRoot, 'cache');
  await fs.mkdir(cacheDir, { recursive: true });
  savedDataRoot = process.env.AI_TRIAD_DATA_ROOT;
  process.env.AI_TRIAD_DATA_ROOT = dataRoot;
});

afterEach(async () => {
  if (savedDataRoot === undefined) delete process.env.AI_TRIAD_DATA_ROOT;
  else process.env.AI_TRIAD_DATA_ROOT = savedDataRoot;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe.skipIf(!isUndiciMajorAlignedWithRuntime())('GitHubAPIBackend path gaps (t/434)', () => {
  async function makeBackend(): Promise<Internals> {
    const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
    const backend = new GitHubAPIBackend({ cacheDir, pollIntervalMs: 999_999_999, coherencyProbeRate: 0 });
    return backend as unknown as Internals;
  }

  describe('1. cache reads and removes are confined to cacheDir', () => {
    it('readFromDiskCache refuses a `../` key and does not read the file outside the cache', async () => {
      const secret = path.join(tmp, 'secret.txt');
      await fs.writeFile(secret, 'outside-the-cache');
      const b = await makeBackend();
      b.manifest = { version: 1, generation: 1, lastCommitSha: '', lastUpdated: '', files: { '../secret.txt': { sha: 'x', etag: '', cachedAt: '' } } };
      expect(await codeOf(b.readFromDiskCache('../secret.txt'))).toBe('PATH_OUTSIDE_ROOT');
    });

    it('readBinaryFromDiskCache refuses a `../` key', async () => {
      await fs.writeFile(path.join(tmp, 'secret.bin'), 'outside-the-cache');
      const b = await makeBackend();
      b.manifest = { version: 1, generation: 1, lastCommitSha: '', lastUpdated: '', files: { '../secret.bin': { sha: 'x', etag: '', cachedAt: '' } } };
      expect(await codeOf(b.readBinaryFromDiskCache('../secret.bin'))).toBe('PATH_OUTSIDE_ROOT');
    });

    it('removeFromDiskCache refuses a `../` key and leaves the file outside the cache in place', async () => {
      const victim = path.join(tmp, 'victim.txt');
      await fs.writeFile(victim, 'keep me');
      const b = await makeBackend();
      expect(await codeOf(b.removeFromDiskCache('../victim.txt'))).toBe('PATH_OUTSIDE_ROOT');
      expect(await fs.readFile(victim, 'utf-8')).toBe('keep me');
    });

    it('an in-cache read still works', async () => {
      await fs.mkdir(path.join(cacheDir, 'taxonomy'), { recursive: true });
      await fs.writeFile(path.join(cacheDir, 'taxonomy', 'a.json'), '{"ok":1}');
      const b = await makeBackend();
      b.manifest = { version: 1, generation: 1, lastCommitSha: '', lastUpdated: '', files: { 'taxonomy/a.json': { sha: 'x', etag: '', cachedAt: '' } } };
      expect(await b.readFromDiskCache('taxonomy/a.json')).toBe('{"ok":1}');
    });
  });

  describe('2. absolute, drive-letter and UNC paths outside the data root are refused', () => {
    it.each([
      ['a drive-letter path', 'C:\\Windows\\win.ini'],
      ['a forward-slash drive-letter path', 'C:/Windows/win.ini'],
      ['a UNC path', '\\\\server\\share\\secret.txt'],
    ])('toRepoPath refuses %s', async (_label, input) => {
      const b = await makeBackend();
      expect(codeOfSync(() => b.toRepoPath(input))).toBe('PATH_OUTSIDE_ROOT');
    });
  });

  describe('3. a sibling that shares the data root name prefix is refused', () => {
    it('toRepoPath refuses `<root>-evil/x` instead of rewriting it into a repo path', async () => {
      const b = await makeBackend();
      expect(codeOfSync(() => b.toRepoPath(`${dataRoot}-evil/escape.json`))).toBe('PATH_OUTSIDE_ROOT');
    });

    it('toRepoPath still strips a path inside the root', async () => {
      const b = await makeBackend();
      expect(b.toRepoPath(`${dataRoot}/taxonomy/nodes.json`)).toBe('taxonomy/nodes.json');
    });
  });

  describe('4. NUL bytes are refused and backslash separators are normalised', () => {
    it('toRepoPath refuses a NUL byte', async () => {
      const b = await makeBackend();
      expect(codeOfSync(() => b.toRepoPath('taxonomy/x\0.json'))).toBe('INVALID_PATH');
    });

    it('toRepoPath normalises backslash separators to forward slashes', async () => {
      const b = await makeBackend();
      expect(b.toRepoPath('taxonomy\\nodes.json')).toBe('taxonomy/nodes.json');
    });
  });
});
