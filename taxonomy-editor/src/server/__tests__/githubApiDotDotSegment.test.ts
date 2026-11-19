// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/457: toRepoPath refused any repo path containing the two characters `..`, so a valid name such
 * as `foo..json` was falsely rejected. confineToDir keeps in-root paths inside the root, so this was
 * a false rejection, not a containment gap. The check now refuses `..` only as a whole path segment.
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

type Internals = { toRepoPath: (filePath: string) => string };

let tmp: string;
let dataRoot: string;
let savedDataRoot: string | undefined;
let backend: Internals;

/** The `code` of the error a synchronous call throws, or undefined when it does not throw. */
function codeOfSync(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code ?? 'THREW';
  }
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gh-dotdot-')));
  dataRoot = path.join(tmp, 'root');
  await fs.mkdir(dataRoot, { recursive: true });
  savedDataRoot = process.env.AI_TRIAD_DATA_ROOT;
  process.env.AI_TRIAD_DATA_ROOT = dataRoot;
  backend = new GitHubAPIBackend({ cacheDir: path.join(dataRoot, 'cache'), pollIntervalMs: 999_999_999, coherencyProbeRate: 0 }) as unknown as Internals;
});

afterEach(async () => {
  if (savedDataRoot === undefined) delete process.env.AI_TRIAD_DATA_ROOT;
  else process.env.AI_TRIAD_DATA_ROOT = savedDataRoot;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GitHubAPIBackend toRepoPath: `..` is refused only as a path segment (t/457)', () => {
  it.each([
    ['a file name containing ..', 'foo..json', 'foo..json'],
    ['a file name containing .. inside a folder', 'taxonomy/foo..json', 'taxonomy/foo..json'],
    ['a folder name containing ..', 'a..b/nodes.json', 'a..b/nodes.json'],
    ['a name that begins with ..', '..hidden.json', '..hidden.json'],
  ])('accepts %s', (_label, input, expected) => {
    expect(backend.toRepoPath(input)).toBe(expected);
  });

  it.each([
    ['a bare ..', '..'],
    ['a leading ../ segment', '../x'],
    ['a ../ segment in the middle', 'taxonomy/../x'],
    ['a trailing /..', 'taxonomy/..'],
    ['a backslash .. segment', '..\\x'],
    ['a backslash .. segment in the middle', 'taxonomy\\..\\x'],
  ])('still refuses %s', (_label, input) => {
    expect(codeOfSync(() => backend.toRepoPath(input))).toBe('THREW');
  });
});
