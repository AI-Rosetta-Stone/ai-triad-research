// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/372 regression tests for CodeQL alerts on githubAPIBackend.ts:
 *  - #6229 / #6230 (js/http-to-file-access): the disk-cache writers joined cacheDir with the
 *    repo path with no confinement.
 *  - #6275 (js/file-access-to-http): dot-segments in the repo path reached another path on
 *    raw.githubusercontent.com.
 *
 * Every filesystem target is inside an fs.mkdtemp directory. The cache dir is `<tmp>/cache`, so a
 * `../` escape lands in `<tmp>`; a regressed guard writes only there, never to the machine or repo.
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
  writeToDiskCache: (repoPath: string, content: string, sha: string, etag: string) => Promise<void>;
  writeBinaryToDiskCache: (repoPath: string, content: Buffer, sha: string, etag: string) => Promise<void>;
  fetchFileFromRaw: (repoPath: string, commitSha: string) => Promise<{ kind: string; reason?: string }>;
  getCredsCached: () => Promise<{ repo: string; token: string; mode: 'pat' } | null>;
  rawDisabled: boolean;
};

let tmp: string;
let cacheDir: string;
let backend: GitHubAPIBackend;
let internals: Internals;

const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

/** Every file under `dir`, relative to `tmp`, sorted, so a test can assert nothing new appeared. */
async function listAll(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    out.push(path.relative(tmp, full));
    if (e.isDirectory()) out.push(...(await listAll(full)));
  }
  return out.sort();
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gh-confine-')));
  cacheDir = path.join(tmp, 'cache');
  await fs.mkdir(cacheDir, { recursive: true });
  backend = new GitHubAPIBackend({ cacheDir, pollIntervalMs: 999_999_999, coherencyProbeRate: 0 });
  internals = backend as unknown as Internals;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GitHubAPIBackend disk-cache confinement (t/372: CodeQL #6229, #6230)', () => {
  it('writeToDiskCache: a `../` repo path writes nothing outside cacheDir', async () => {
    const before = await listAll(tmp);
    await internals.writeToDiskCache('../escape-text.txt', 'attack', 'sha', '');
    expect(await exists(path.join(tmp, 'escape-text.txt'))).toBe(false);
    expect(await listAll(tmp)).toEqual(before);
  });

  it('writeBinaryToDiskCache: a `../` repo path writes nothing outside cacheDir', async () => {
    const before = await listAll(tmp);
    await internals.writeBinaryToDiskCache('../../escape-bin.bin', Buffer.from('attack'), 'sha', '');
    expect(await exists(path.join(tmp, 'escape-bin.bin'))).toBe(false);
    expect(await listAll(tmp)).toEqual(before);
  });

  it('an in-cache path is still written (the guard refuses escapes, not normal paths)', async () => {
    await internals.writeToDiskCache('taxonomy/Origin/a.json', '{"ok":1}', 'sha', '');
    expect(await fs.readFile(path.join(cacheDir, 'taxonomy', 'Origin', 'a.json'), 'utf-8')).toBe('{"ok":1}');
  });

  it('a file name containing ".." that does not escape is allowed', async () => {
    await internals.writeToDiskCache('foo..json', '{"ok":2}', 'sha', '');
    expect(await fs.readFile(path.join(cacheDir, 'foo..json'), 'utf-8')).toBe('{"ok":2}');
  });
});

describe('GitHubAPIBackend raw fetch dot-segments (t/372: CodeQL #6275)', () => {
  beforeEach(() => {
    internals.rawDisabled = false;
    internals.getCredsCached = async () => ({ repo: 'testowner/testrepo', token: 't', mode: 'pat' });
  });

  it.each([
    ['a/../b.json'],
    ['a/./b.json'],
    ['..'],
    ['taxonomy/../../other/secret.json'],
  ])('refuses "%s" before any request is built', async (repoPath) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await internals.fetchFileFromRaw(repoPath, 'deadbeef');
    expect(result).toEqual({ kind: 'fallback', reason: 'invalid_path' });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('a normal repo path still builds the raw URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await internals.fetchFileFromRaw('taxonomy/Origin/a.json', 'deadbeef');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://raw.githubusercontent.com/testowner/testrepo/deadbeef/taxonomy/Origin/a.json',
    );
    vi.unstubAllGlobals();
  });
});
