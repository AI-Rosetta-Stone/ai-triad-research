// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/547: a poll-lease non-holder catching up from the holder's published poll state.
 *
 * Two defects: (1) the incremental catch-up reloaded the tree at the PREVIOUS commit (the manifest commit
 * was advanced only afterwards), so a changed file was read through the old tree's blob SHA and kept
 * serving old content; (2) a heartbeat with an empty change history counted as a gap, so every non-holder
 * wiped its whole cache on every tick until the first change. The invariant now: the manifest's entries and
 * the live tree describe manifest.lastCommitSha; nothing changes until the published commit's tree loads.
 * Every filesystem target is inside an fs.mkdtemp directory.
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

const OLD = '1111111111111111111111111111111111111111';
const NEW = '2222222222222222222222222222222222222222';
const OLD_TREE = '3333333333333333333333333333333333333333';
const NEW_TREE = '4444444444444444444444444444444444444444';
const CHANGED = 'taxonomy/a.json';
const UNCHANGED = 'taxonomy/b.json';
const HOLDER = 'holder-1';

type Resp = { ok: boolean; status?: number; data?: unknown };
type ManifestFile = { sha: string; etag: string; cachedAt: string };
type Manifest = { version: number; generation: number; lastCommitSha: string; lastUpdated: string; files: Record<string, ManifestFile> };
type PollState = { holderId: string; generation: number; lastCommitSha: string; changedSinceGeneration: Array<{ generation: number; paths: string[] }>; publishedAt: string };
type Internals = {
  manifest: Manifest | null;
  rest: { isTripped: () => boolean; request: (creds: unknown, method: string, p: string) => Promise<Resp> };
  getCredsCached: () => Promise<{ repo: string; token: string; mode: 'pat' } | null>;
  loadManifest: () => Promise<void>;
  pollAsNonHolder: () => Promise<void>;
  readPollState: () => Promise<PollState | null>;
  getFileSha: (p: string, ref: string) => Promise<string | null>;
  repoTree: Map<string, { sha: string }>;
  treeSha: string | null;
  pollLastSeenGeneration: number;
  pollLastSeenHolderId: string | null;
  pollLastSeenCommitSha: string;
};

let newTreeFails: boolean;
let treeRequests: string[];
let tmp: string;
let cacheDir: string;

function router(_creds: unknown, _method: string, p: string): Promise<Resp> {
  if (p === `/repos/testowner/testrepo/git/commits/${OLD}`) return Promise.resolve({ ok: true, data: { tree: { sha: OLD_TREE } } });
  if (p === `/repos/testowner/testrepo/git/commits/${NEW}`) {
    return Promise.resolve(newTreeFails ? { ok: false, status: 503, data: {} } : { ok: true, data: { tree: { sha: NEW_TREE } } });
  }
  if (p.startsWith('/repos/testowner/testrepo/git/trees/')) {
    const isNew = p.includes(NEW_TREE);
    treeRequests.push(isNew ? 'new' : 'old');
    const tree = [
      { path: CHANGED, type: 'blob', mode: '100644', sha: isNew ? 'NEWBLOB' : 'OLDBLOB' },
      { path: UNCHANGED, type: 'blob', mode: '100644', sha: 'SAMEBLOB' },
      ...(isNew ? [{ path: 'taxonomy/added.json', type: 'blob', mode: '100644', sha: 'ADDED' }] : []),
    ];
    return Promise.resolve({ ok: true, data: { tree, truncated: false } });
  }
  return Promise.resolve({ ok: false, status: 404, data: {} });
}

beforeAll(async () => {
  await import('../storage/githubAPIBackend');
}, 60_000);

beforeEach(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gh-nonholder-')));
  cacheDir = path.join(tmp, 'cache');
  await fsp.mkdir(cacheDir, { recursive: true });
  // A running non-holder at the old commit, with both files cached.
  const at = '2026-11-01T00:00:00Z';
  await fsp.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify({
    version: 1, generation: 3, lastCommitSha: OLD, lastUpdated: at,
    files: { [CHANGED]: { sha: 'OLDBLOB', etag: '', cachedAt: at }, [UNCHANGED]: { sha: 'SAMEBLOB', etag: '', cachedAt: at } },
  }));
  newTreeFails = false;
  treeRequests = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** A non-holder that has already applied generation 5 from HOLDER at the old commit. */
async function makeNonHolder(): Promise<Internals> {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const b = new GitHubAPIBackend({ cacheDir, pollIntervalMs: 60_000, coherencyProbeRate: 0 }) as unknown as Internals;
  b.rest = { isTripped: () => false, request: router };
  b.getCredsCached = async () => ({ repo: 'testowner/testrepo', token: 't', mode: 'pat' });
  await b.loadManifest();
  b.repoTree.set(CHANGED, { sha: 'OLDBLOB' });
  b.repoTree.set(UNCHANGED, { sha: 'SAMEBLOB' });
  b.treeSha = OLD_TREE;
  b.pollLastSeenGeneration = 5;
  b.pollLastSeenHolderId = HOLDER;
  b.pollLastSeenCommitSha = OLD;
  return b;
}

function publish(b: Internals, state: Partial<PollState>): void {
  const full: PollState = { holderId: HOLDER, generation: 6, lastCommitSha: OLD, changedSinceGeneration: [], publishedAt: new Date().toISOString(), ...state };
  b.readPollState = async () => full;
}

const STEP_TO_NEW: Partial<PollState> = { generation: 6, lastCommitSha: NEW, changedSinceGeneration: [{ generation: 6, paths: [CHANGED] }] };

describe.skipIf(!isUndiciMajorAlignedWithRuntime())('poll-lease non-holder catch-up (t/547)', () => {
  it('an incremental step reads the changed file at the NEW commit\'s blob, not the old one', async () => {
    const b = await makeNonHolder();
    publish(b, STEP_TO_NEW);
    await b.pollAsNonHolder();

    expect(b.manifest?.lastCommitSha).toBe(NEW);
    expect(b.treeSha).toBe(NEW_TREE);
    expect(await b.getFileSha(CHANGED, 'main')).toBe('NEWBLOB');
    expect(b.repoTree.has('taxonomy/added.json')).toBe(true);
    // Only the changed path is dropped; the unchanged file keeps its cache entry.
    expect(b.manifest?.files[CHANGED]).toBeUndefined();
    expect(b.manifest?.files[UNCHANGED]).toBeDefined();
    expect(treeRequests).toEqual(['new']);
    expect(b.pollLastSeenGeneration).toBe(6);
    expect(b.pollLastSeenCommitSha).toBe(NEW);
  });

  it('when the new commit\'s tree fails to load, nothing moves, and the next tick applies the step', async () => {
    newTreeFails = true;
    const b = await makeNonHolder();
    publish(b, STEP_TO_NEW);
    await b.pollAsNonHolder();

    expect(b.manifest?.lastCommitSha).toBe(OLD);
    expect(b.manifest?.files[CHANGED]?.sha).toBe('OLDBLOB');
    expect(b.treeSha).toBe(OLD_TREE);
    expect(b.pollLastSeenGeneration).toBe(5);

    newTreeFails = false;
    await b.pollAsNonHolder();
    expect(b.manifest?.lastCommitSha).toBe(NEW);
    expect(await b.getFileSha(CHANGED, 'main')).toBe('NEWBLOB');
    expect(b.manifest?.files[UNCHANGED]).toBeDefined();
  });

  it('a heartbeat at our commit with an empty history changes nothing and fetches nothing', async () => {
    const b = await makeNonHolder();
    for (const generation of [6, 7, 8]) {
      publish(b, { generation, lastCommitSha: OLD, changedSinceGeneration: [] });
      await b.pollAsNonHolder();
    }
    expect(treeRequests).toEqual([]);
    expect(b.treeSha).toBe(OLD_TREE);
    expect(Object.keys(b.manifest?.files ?? {}).sort()).toEqual([CHANGED, UNCHANGED]);
    expect(b.pollLastSeenGeneration).toBe(8);
  });

  it('a first observation at our own commit (a fresh boot) keeps the cache', async () => {
    const b = await makeNonHolder();
    b.pollLastSeenGeneration = 0;
    b.pollLastSeenHolderId = null;
    b.pollLastSeenCommitSha = '';
    publish(b, { generation: 40, lastCommitSha: OLD });
    await b.pollAsNonHolder();
    expect(treeRequests).toEqual([]);
    expect(Object.keys(b.manifest?.files ?? {}).sort()).toEqual([CHANGED, UNCHANGED]);
  });

  const UNKNOWN_PATHS: Array<[string, (b: Internals) => void, Partial<PollState>]> = [
    ['the holder changed', () => {}, { ...STEP_TO_NEW, holderId: 'holder-2' }],
    ['this is the first observation', (b) => { b.pollLastSeenGeneration = 0; b.pollLastSeenHolderId = null; }, STEP_TO_NEW],
    ['our manifest moved since the last applied state (direct-poll fallback)', (b) => { b.pollLastSeenCommitSha = 'cccccccccccccccccccccccccccccccccccccccc'; }, STEP_TO_NEW],
    ['the history was cut at its cap past our generation', () => {},
      { generation: 60, lastCommitSha: NEW, changedSinceGeneration: Array.from({ length: 50 }, (_, i) => ({ generation: 11 + i, paths: ['taxonomy/other.json'] })) }],
  ];

  it.each(UNKNOWN_PATHS)('when %s, the commit moves and every cached file entry is dropped', async (_name, setup, state) => {
    const b = await makeNonHolder();
    setup(b);
    publish(b, state);
    await b.pollAsNonHolder();
    expect(b.manifest?.lastCommitSha).toBe(NEW);
    expect(b.manifest?.files).toEqual({});
    expect(await b.getFileSha(CHANGED, 'main')).toBe('NEWBLOB');
  });

  it('gaps between history entries are not a cut: generations without changes are simply absent', async () => {
    const b = await makeNonHolder();
    publish(b, { generation: 12, lastCommitSha: NEW, changedSinceGeneration: [{ generation: 2, paths: [UNCHANGED] }, { generation: 9, paths: [CHANGED] }] });
    await b.pollAsNonHolder();
    expect(b.manifest?.files[CHANGED]).toBeUndefined();
    expect(b.manifest?.files[UNCHANGED]).toBeDefined(); // generation 2 was before our last-seen 5
  });
});
