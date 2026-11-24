// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/432 (TL p/50#94): the duplicate '..' rule is kept on purpose, as defence in depth. This file pins
 * how a single '.' segment is handled, so the behaviour is deliberate and cannot drift silently:
 *  - toRepoPath allows '.' (existing callers, t/2670), and does not normalise it away.
 *  - fetchFileFromRaw refuses '.' and '..' before any URL is built, because a dot-segment in a URL
 *    is normalised by the URL parser to another path on raw.githubusercontent.com (CodeQL #6275).
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
  rawDisabled: boolean;
  getCredsCached: () => Promise<{ repo: string; token: string; mode: 'pat' } | null>;
  toRepoPath: (filePath: string) => string;
  fetchFileFromRaw: (repoPath: string, commitSha: string) => Promise<{ kind: string; reason?: string }>;
};

let tmp: string;
let savedDataRoot: string | undefined;
let b: Internals;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gh-dot-pin-')));
  savedDataRoot = process.env.AI_TRIAD_DATA_ROOT;
  process.env.AI_TRIAD_DATA_ROOT = path.join(tmp, 'root');
  b = new GitHubAPIBackend({ cacheDir: path.join(tmp, 'root', 'cache'), pollIntervalMs: 999_999_999, coherencyProbeRate: 0 }) as unknown as Internals;
  b.rawDisabled = false;
  b.getCredsCached = async () => ({ repo: 'testowner/testrepo', token: 't', mode: 'pat' });
});

afterEach(async () => {
  if (savedDataRoot === undefined) delete process.env.AI_TRIAD_DATA_ROOT;
  else process.env.AI_TRIAD_DATA_ROOT = savedDataRoot;
  vi.unstubAllGlobals();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("a single '.' segment is handled on purpose (t/432, TL p/50#94)", () => {
  it("toRepoPath allows '.' and does not normalise it away", () => {
    expect(b.toRepoPath('taxonomy/./nodes.json')).toBe('taxonomy/./nodes.json');
  });

  it("fetchFileFromRaw refuses '.' before any URL is built", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await b.fetchFileFromRaw('taxonomy/./nodes.json', 'deadbeef')).toEqual({ kind: 'fallback', reason: 'invalid_path' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
