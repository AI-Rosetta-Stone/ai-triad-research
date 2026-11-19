// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/432 (Security residual on #5169): confineToDir checked only the lexical path. A symlink or junction
 * already inside the cache directory could lead a cache write or read outside it. These tests plant such
 * a link under `<tmp>/cache` pointing at `<tmp>/outside`. Every target is inside an fs.mkdtemp directory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/testrepo', token: 't', mode: 'pat' }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getDefaultBranch: vi.fn().mockReturnValue('main'),
  invalidateCredentials: vi.fn(),
}));

import { GitHubAPIBackend } from '../storage/githubAPIBackend.js';

type Internals = {
  manifest: { version: number; generation: number; lastCommitSha: string; lastUpdated: string; files: Record<string, { sha: string; etag: string; cachedAt: string }> } | null;
  writeToDiskCache: (repoPath: string, content: string, sha: string, etag: string) => Promise<void>;
  readFromDiskCache: (repoPath: string) => Promise<string | null>;
};

let tmp: string;
let cacheDir: string;
let outside: string;

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(() => undefined, (e: unknown) => (e as { code?: string }).code);
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gh-symlink-')));
  cacheDir = path.join(tmp, 'cache');
  outside = path.join(tmp, 'outside');
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  // A link inside the cache directory that leads out of it.
  await fs.symlink(outside, path.join(cacheDir, 'link'), 'junction');
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function makeBackend(): Internals {
  return new GitHubAPIBackend({ cacheDir, pollIntervalMs: 999_999_999, coherencyProbeRate: 0 }) as unknown as Internals;
}

describe('GitHubAPIBackend disk cache does not follow a symlink out of cacheDir (t/432)', () => {
  it('a cache write through an in-cache link writes nothing outside cacheDir', async () => {
    const b = makeBackend();
    await b.writeToDiskCache('link/escape.txt', 'attack', 'sha', '');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('a cache read through an in-cache link is refused, not read from outside', async () => {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside-the-cache');
    const b = makeBackend();
    b.manifest = { version: 1, generation: 1, lastCommitSha: '', lastUpdated: '', files: { 'link/secret.txt': { sha: 'x', etag: '', cachedAt: '' } } };
    expect(await codeOf(b.readFromDiskCache('link/secret.txt'))).toBe('PATH_OUTSIDE_ROOT');
  });

  it('a normal in-cache write still lands in cacheDir (the control)', async () => {
    const b = makeBackend();
    await b.writeToDiskCache('taxonomy/nodes.json', '{"ok":1}', 'sha', '');
    expect(await fs.readFile(path.join(cacheDir, 'taxonomy', 'nodes.json'), 'utf-8')).toBe('{"ok":1}');
  });
});
