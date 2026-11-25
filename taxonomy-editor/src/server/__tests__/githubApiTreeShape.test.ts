// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/470: an OK GitHub response with the wrong shape (no body, no tree, no tree.sha) must be a failed
 * load, never a throw. getTree and fetchRepoTree are not inside a try, so a TypeError there rejected
 * initialize(). Every filesystem target is inside an fs.mkdtemp directory.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';

vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/testrepo', token: 't', mode: 'pat' }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getDefaultBranch: vi.fn().mockReturnValue('main'),
  invalidateCredentials: vi.fn(),
}));

const HEAD = '2222222222222222222222222222222222222222';
const TREE = '3333333333333333333333333333333333333333';

type Resp = { ok: boolean; status?: number; data?: unknown };
type Internals = {
  rest: { isTripped: () => boolean; request: (creds: unknown, method: string, p: string) => Promise<Resp> };
  getCredsCached: () => Promise<{ repo: string; token: string; mode: 'pat' } | null>;
  initialize: () => Promise<void>;
  shutdown: () => void;
  _dataLoadStatus: string;
  getTree: (sha: string, recursive?: boolean) => Promise<unknown[]>;
  fetchRepoTree: (sha: string) => Promise<boolean>;
  repoTree: Map<string, unknown>;
  treeSha: string | null;
};

const GOOD_COMMIT: Resp = { ok: true, status: 200, data: { tree: { sha: TREE } } };
const GOOD_TREE: Resp = {
  ok: true, status: 200,
  data: { tree: [{ path: 'taxonomy/a.json', type: 'blob', mode: '100644', sha: 'BLOB' }], truncated: false },
};

let tmp: string;
let cacheDir: string;
let commitResp: Resp;
let treeResp: Resp;

function router(_creds: unknown, _method: string, p: string): Promise<Resp> {
  if (p === '/repos/testowner/testrepo/commits/main') return Promise.resolve({ ok: true, data: { sha: HEAD } });
  if (p === `/repos/testowner/testrepo/git/commits/${HEAD}`) return Promise.resolve(commitResp);
  if (p.startsWith(`/repos/testowner/testrepo/git/trees/${TREE}`)) return Promise.resolve(treeResp);
  return Promise.resolve({ ok: false, status: 404, data: {} });
}

// The first import of the backend is slow under a loaded full-suite run; pay for it here, not in a test.
beforeAll(async () => {
  await import('../storage/githubAPIBackend');
}, 60_000);

beforeEach(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gh-tree-shape-')));
  cacheDir = path.join(tmp, 'cache');
  commitResp = GOOD_COMMIT;
  treeResp = GOOD_TREE;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function makeBackend(): Promise<Internals> {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const b = new GitHubAPIBackend({ cacheDir, pollIntervalMs: 999_999_999, coherencyProbeRate: 0 }) as unknown as Internals;
  b.rest = { isTripped: () => false, request: router };
  b.getCredsCached = async () => ({ repo: 'testowner/testrepo', token: 't', mode: 'pat' });
  return b;
}

/** Seed a live tree, so each case can assert that a failed load leaves it untouched. */
function seedLive(b: Internals): void {
  b.repoTree.set('keep/live.json', { path: 'keep/live.json', mode: '100644', type: 'blob', sha: 'LIVE' });
  b.treeSha = 'PREV-TREE';
}

function expectLiveUntouched(b: Internals): void {
  expect(b.repoTree.has('keep/live.json')).toBe(true);
  expect(b.repoTree.size).toBe(1);
  expect(b.treeSha).toBe('PREV-TREE');
}

const BAD_TREE_BODIES: Array<[string, Resp]> = [
  ['no body (undefined)', { ok: true, status: 200 }],
  ['a null body', { ok: true, status: 200, data: null }],
  ['a body without tree', { ok: true, status: 200, data: {} }],
  ['a tree that is not an array', { ok: true, status: 200, data: { tree: 'nope' } }],
  ['a truncated body without tree', { ok: true, status: 200, data: { truncated: true } }],
];

const BAD_COMMIT_BODIES: Array<[string, Resp]> = [
  ['no body (undefined)', { ok: true, status: 200 }],
  ['a null body', { ok: true, status: 200, data: null }],
  ['a body without tree', { ok: true, status: 200, data: {} }],
  ['a null tree', { ok: true, status: 200, data: { tree: null } }],
  ['a tree without sha', { ok: true, status: 200, data: { tree: {} } }],
  ['an empty tree.sha', { ok: true, status: 200, data: { tree: { sha: '' } } }],
  ['a non-string tree.sha', { ok: true, status: 200, data: { tree: { sha: 42 } } }],
];

describe.skipIf(!isUndiciMajorAlignedWithRuntime())('GitHubAPIBackend treats a wrong-shaped OK response as a failed load (t/470)', () => {
  describe('getTree', () => {
    it.each(BAD_TREE_BODIES)('returns [] on an OK response with %s', async (_name, resp) => {
      treeResp = resp;
      const b = await makeBackend();
      await expect(b.getTree(TREE, true)).resolves.toEqual([]);
    });

    it('control: a well-formed response returns its entries', async () => {
      const b = await makeBackend();
      await expect(b.getTree(TREE, true)).resolves.toHaveLength(1);
    });
  });

  describe('fetchRepoTree', () => {
    it.each(BAD_COMMIT_BODIES)('returns false and keeps the live tree on an OK commit response with %s', async (_name, resp) => {
      commitResp = resp;
      const b = await makeBackend();
      seedLive(b);
      await expect(b.fetchRepoTree(HEAD)).resolves.toBe(false);
      expectLiveUntouched(b);
    });

    it.each(BAD_TREE_BODIES)('returns false and keeps the live tree on an OK tree response with %s', async (_name, resp) => {
      treeResp = resp;
      const b = await makeBackend();
      seedLive(b);
      await expect(b.fetchRepoTree(HEAD)).resolves.toBe(false);
      expectLiveUntouched(b);
    });

    it('skips entries that are not objects with a path, and loads the rest', async () => {
      treeResp = {
        ok: true, status: 200,
        data: { tree: [null, { type: 'blob', sha: 'NOPATH' }, { path: 'taxonomy/a.json', type: 'blob', mode: '100644', sha: 'BLOB' }] },
      };
      const b = await makeBackend();
      await expect(b.fetchRepoTree(HEAD)).resolves.toBe(true);
      expect([...b.repoTree.keys()]).toEqual(['taxonomy/a.json']);
      expect(b.treeSha).toBe(TREE);
    });

    it('control: a well-formed commit and tree load and set treeSha', async () => {
      const b = await makeBackend();
      await expect(b.fetchRepoTree(HEAD)).resolves.toBe(true);
      expect(b.repoTree.has('taxonomy/a.json')).toBe(true);
      expect(b.treeSha).toBe(TREE);
    });
  });

  describe('initialize', () => {
    it('reports failed, without rejecting, when the commit response has no body', async () => {
      commitResp = { ok: true, status: 200 };
      const b = await makeBackend();
      await expect(b.initialize()).resolves.toBeUndefined();
      try {
        expect(b._dataLoadStatus).toBe('failed');
      } finally {
        b.shutdown();
      }
    });

    it('reports failed, without rejecting, when the tree response has no body', async () => {
      treeResp = { ok: true, status: 200 };
      const b = await makeBackend();
      await expect(b.initialize()).resolves.toBeUndefined();
      try {
        expect(b._dataLoadStatus).toBe('failed');
      } finally {
        b.shutdown();
      }
    });

    it('control: a well-formed commit and tree report ready', async () => {
      const b = await makeBackend();
      await expect(b.initialize()).resolves.toBeUndefined();
      try {
        expect(b._dataLoadStatus).toBe('ready');
      } finally {
        b.shutdown();
      }
    });
  });
});
