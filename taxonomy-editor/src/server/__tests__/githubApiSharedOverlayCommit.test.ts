// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/550 commit 2 (t/503 rulings, SO t/503#8 conditions 3 and 4): with shared overlay state active, a commit takes the
 * user's commit lease, takes its batch from the shared store alone, clears by ETag, and rebases an entry rewritten
 * mid-commit. Two GitHubAPIBackend replicas on one Azurite store and a small fake GitHub that records the trees, commits
 * and ref updates. Own Azurite port (10012). Gated on skipForUndiciSkewOutsideCi: skipped only locally, never in CI (TL t/503#22).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import { skipForUndiciSkewOutsideCi } from '../storage/undiciInvariant.js';
import { SharedOverlayStore } from '../storage/sharedOverlayStore.js';
import { BlobLease } from '../storage/blobLease.js';

// TL t/503#22: skips on a dev machine with undici skew only; in CI it always runs, so skew fails it loudly.
const SKIP_LOCAL_SKEW = skipForUndiciSkewOutsideCi();
const here = path.dirname(fileURLToPath(import.meta.url));
const AZURITE_MAIN = path.resolve(here, '../../../node_modules/azurite/dist/src/blob/main.js');
const PORT = 10012;
const CONN = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:${PORT}/devstoreaccount1;`;
const ACCOUNT_URL = `http://127.0.0.1:${PORT}/devstoreaccount1`;
const CONTAINER = 'overlay-state';
const USER = 'alice';
const BRANCH = 'api-session/alice';
const FILE = '/conflicts/foo.json';
const REPO_PATH = 'conflicts/foo.json';

let proc: ChildProcess;
let service: BlobServiceClient;
let azuriteDir: string;
let counter = 0;

vi.mock('fs/promises', () => ({
  default: {
    realpath: vi.fn(async (p: string) => p),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  },
}));

vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/testrepo', token: 'test-token-abc123', mode: 'pat' as const }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getTokenExpiryMs: vi.fn().mockReturnValue(0),
}));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: vi.fn().mockReturnValue({ record: vi.fn() }),
  FlightRecorder: vi.fn(),
}));

function blobSha(content: string): string {
  const buf = Buffer.from(content, 'utf-8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

const headers = { 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) };
function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: new Headers(headers) });
}

/** A tiny GitHub: the session branch head, its committed blobs, and the trees/commits created. */
type Gh = { head: string; committed: Map<string, string>; trees: Map<string, Array<{ path: string; content?: string; sha?: null }>>; commits: Map<string, string>; parents: Map<string, string>; refUpdates: number; refRejections: number; onTreePost?: () => Promise<void> };
let gh: Gh;
let seq = 0;

async function fakeGithub(url: string, init?: RequestInit): Promise<Response> {
  const p = url.replace('https://api.github.com', '');
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  if (method === 'GET' && p.includes('/git/refs/heads/')) return respond(200, { object: { sha: gh.head } });
  if (method === 'GET' && p.includes('/git/trees/') && p.includes('recursive=1')) {
    return respond(200, { sha: 't', truncated: false, tree: [...gh.committed].map(([path, sha]) => ({ path, sha, type: 'blob' })) });
  }
  if (method === 'GET' && p.includes('/git/trees/')) return respond(200, { sha: 't', truncated: false, tree: [] });
  if (method === 'POST' && p.endsWith('/git/trees')) {
    if (gh.onTreePost) await gh.onTreePost();
    const sha = `tree-${++seq}`;
    gh.trees.set(sha, body.tree as Array<{ path: string; content?: string; sha?: null }>);
    return respond(201, { sha });
  }
  if (method === 'POST' && p.endsWith('/git/commits')) {
    const sha = `commit-${++seq}`;
    gh.commits.set(sha, body.tree as string);
    gh.parents.set(sha, (body.parents as string[])[0]);
    return respond(201, { sha });
  }
  if (method === 'PATCH' && p.includes('/git/refs/heads/')) {
    const commit = body.sha as string;
    if (body.force !== true && gh.parents.get(commit) !== gh.head) { gh.refRejections++; return respond(422, { message: 'Update is not a fast forward' }); }
    gh.refUpdates++;
    for (const e of gh.trees.get(gh.commits.get(commit)!) ?? []) {
      if (e.sha === null) gh.committed.delete(e.path); else gh.committed.set(e.path, blobSha(e.content ?? ''));
    }
    gh.head = commit;
    return respond(200, { object: { sha: commit } });
  }
  return respond(404, { message: 'Not Found' });
}

/** Every tree entry the fake GitHub received, across commits. */
function committedTreeEntries(): Array<{ path: string; content?: string; sha?: null }> {
  return [...gh.trees.values()].flat();
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  gh = { head: 'base-commit', committed: new Map(), trees: new Map(), commits: new Map(), parents: new Map(), refUpdates: 0, refRejections: 0 };
  vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test');
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return fakeGithub(url, init);
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

let prefix: string;
function makeStore(): SharedOverlayStore {
  return new SharedOverlayStore({ accountUrl: ACCOUNT_URL, container: CONTAINER, blobPrefix: prefix, serviceClient: service });
}

async function createReplica(lock: { leaseSeconds?: number; maxHoldMs?: number; draining?: boolean; lockService?: BlobServiceClient } = {}) {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const backend = new GitHubAPIBackend({
    cacheDir: `/var/cache/taxonomy-test-${++counter}`,
    recorder: { record: vi.fn(), flush: vi.fn(), toJSON: vi.fn().mockReturnValue([]), intern: vi.fn() } as never,
    pollIntervalMs: 999_999_999,
    coherencyProbeRate: 0,
    sharedOverlayState: {
      store: makeStore(), forceActiveForTesting: true, draining: lock.draining ?? false,
      commitLock: { accountUrl: ACCOUNT_URL, container: `${CONTAINER}-locks-${prefix}`.toLowerCase().replace(/_/g, '-'), serviceClient: lock.lockService ?? service, leaseSeconds: lock.leaseSeconds ?? 15, maxHoldMs: lock.maxHoldMs },
    },
  });
  await backend.initialize();
  backend.setSessionContext({ userId: USER, branchName: BRANCH });
  return backend;
}

function lockContainer(): string {
  return `${CONTAINER}-locks-${prefix}`.toLowerCase().replace(/_/g, '-');
}

describe.skipIf(SKIP_LOCAL_SKEW)('GitHubAPIBackend — shared overlay commit under the per-user commit lease (t/550)', () => {
  beforeAll(async () => {
    azuriteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-overlay-commit-test-'));
    proc = spawn(process.execPath,
      [AZURITE_MAIN, '--silent', '--skipApiVersionCheck', '--location', azuriteDir, '--blobHost', '127.0.0.1', '--blobPort', String(PORT)],
      { stdio: 'ignore', windowsHide: true });
    service = BlobServiceClient.fromConnectionString(CONN);
    const start = Date.now();
    for (;;) {
      try { await service.getProperties(); break; } catch (e) {
        if (Date.now() - start > 20_000) throw e;
        await new Promise(r => setTimeout(r, 250));
      }
    }
    await service.getContainerClient(CONTAINER).createIfNotExists();
  }, 30_000);

  afterAll(async () => {
    if (proc) proc.kill();
    try { fs.rmSync(azuriteDir, { recursive: true, force: true }); } catch { /* emulator may still hold a handle */ }
  });

  beforeEach(async () => {
    prefix = `t${++counter}`;
    await service.getContainerClient(lockContainer()).createIfNotExists();
  });

  it('a replica commits a save made on another replica (the batch is the shared store), then the store is empty', async () => {
    const a = await createReplica();
    const b = await createReplica();
    await a.writeFile(FILE, 'saved on A');
    const result = await b.commitOverlay(USER, undefined, { branchName: BRANCH });
    expect(result).toMatchObject({ filesCommitted: 1 });
    expect(committedTreeEntries()).toEqual([expect.objectContaining({ path: REPO_PATH, content: 'saved on A' })]);
    expect(await makeStore().listEntries(USER)).toEqual([]);
  });

  // SO t/503#8 risk 1 / condition 4: X saved on B, then Y on A; A commits Y. B's local map still holds X, but the batch
  // is the store alone, so B never commits X over Y.
  it('risk 1: B never commits its stale local X over A\'s committed Y', async () => {
    const a = await createReplica();
    const b = await createReplica();
    await b.writeFile(FILE, 'X');
    await a.writeFile(FILE, 'Y', { baseSha: blobSha('X') });
    await a.commitOverlay(USER, undefined, { branchName: BRANCH });
    expect(await b.commitOverlay(USER, undefined, { branchName: BRANCH })).toBeNull();
    expect(committedTreeEntries().map(e => e.content)).toEqual(['Y']);
    expect(gh.committed.get(REPO_PATH)).toBe(blobSha('Y'));
  });

  it('busy: when another replica holds the commit lease, the commit throws OVERLAY_COMMIT_BUSY and commits nothing', async () => {
    const a = await createReplica();
    await a.writeFile(FILE, 'pending');
    const holder = new BlobLease({ accountUrl: ACCOUNT_URL, container: lockContainer(), blobName: `commit-locks/${USER}`, durationSeconds: 15, serviceClient: service });
    expect(await holder.acquireOrRenew()).toBe(true);
    try {
      await expect(a.commitOverlay(USER, undefined, { branchName: BRANCH })).rejects.toMatchObject({ code: 'OVERLAY_COMMIT_BUSY' });
      expect(gh.refUpdates).toBe(0);
      expect((await makeStore().listEntries(USER)).map(e => e.entry.content)).toEqual(['pending']);
    } finally {
      await holder.release();
    }
  });

  // TL ruling 8 (t/503#5): 'busy' must not starve a user. A holder that dies never releases; its lease lapses after its
  // duration and the next attempt on any replica commits.
  it('ruling 8: a dead holder\'s lease lapses and another replica then commits', async () => {
    const a = await createReplica();
    await a.writeFile(FILE, 'pending');
    const dead = new BlobLease({ accountUrl: ACCOUNT_URL, container: lockContainer(), blobName: `commit-locks/${USER}`, durationSeconds: 15, serviceClient: service });
    expect(await dead.acquireOrRenew()).toBe(true); // never renewed, never released
    await expect(a.commitOverlay(USER, undefined, { branchName: BRANCH })).rejects.toMatchObject({ code: 'OVERLAY_COMMIT_BUSY' });
    await new Promise(r => setTimeout(r, 16_000));
    await expect(a.commitOverlay(USER, undefined, { branchName: BRANCH })).resolves.toMatchObject({ filesCommitted: 1 });
  }, 40_000);

  it('a save that lands during the commit survives it, rebased onto the blob just committed', async () => {
    const a = await createReplica();
    const b = await createReplica();
    await a.writeFile(FILE, 'X');
    gh.onTreePost = async () => {
      gh.onTreePost = undefined;
      await b.writeFile(FILE, 'Y', { baseSha: blobSha('X') }); // lands between the listing and the clear
    };
    await a.commitOverlay(USER, undefined, { branchName: BRANCH });
    const left = await makeStore().getEntry(USER, REPO_PATH);
    expect(left).toMatchObject({ content: 'Y', baseSha: blobSha('X') });
    // and the next commit commits Y without a conflict
    await expect(b.commitOverlay(USER, undefined, { branchName: BRANCH })).resolves.toMatchObject({ filesCommitted: 1 });
    expect(gh.committed.get(REPO_PATH)).toBe(blobSha('Y'));
  });

  it('a commit held past maxHoldMs is abandoned before the ref update; entries stay staged', async () => {
    const a = await createReplica({ maxHoldMs: 1 });
    await a.writeFile(FILE, 'pending');
    await expect(a.commitOverlay(USER, undefined, { branchName: BRANCH })).rejects.toMatchObject({ code: 'OVERLAY_COMMIT_LEASE_LOST' });
    expect(gh.refUpdates).toBe(0);
    expect((await makeStore().listEntries(USER)).map(e => e.entry.content)).toEqual(['pending']);
  });

  // t/638 (SO p/269#14): the store may hold an entry written before the allowlist. The shared batch is refused whole.
  it('a shared batch holding a path off the data-repo allowlist is refused whole, with no GitHub write', async () => {
    const a = await createReplica();
    await a.writeFile(FILE, 'allowed');
    await makeStore().stage(USER, 'users/alice/debates/_index.json',
      { content: '{}', baseSha: null, stagedAt: new Date().toISOString(), stageId: 'legacy-1' }, { absent: true });
    await expect(a.commitOverlay(USER, undefined, { branchName: BRANCH })).rejects.toMatchObject({ code: 'DATA_REPO_PATH_REFUSED' });
    expect(gh.trees.size).toBe(0);
    expect(gh.refUpdates).toBe(0);
  });

  it('a stale base in the store is a conflict: nothing commits, the entry stays', async () => {
    const a = await createReplica();
    await a.writeFile(FILE, 'mine'); // staged with baseSha null (absent)
    gh.committed.set(REPO_PATH, blobSha('someone else committed this'));
    const result = await a.commitOverlay(USER, undefined, { branchName: BRANCH });
    expect(result).toMatchObject({ filesCommitted: 0, conflictedPaths: [REPO_PATH] });
    expect(gh.refUpdates).toBe(0);
    expect(await makeStore().getEntry(USER, REPO_PATH)).toMatchObject({ content: 'mine' });
  });

  // t/551: conflict resolution acts on the shared entries, not one replica's read cache.
  it('Use theirs: discards every shared entry, including ones saved on another replica', async () => {
    const a = await createReplica();
    const b = await createReplica();
    await a.writeFile(FILE, 'from A');
    await b.writeFile('/conflicts/bar.json', 'from B');
    const discarded = await a.discardConflictedOverlayEntriesAsync(USER);
    expect(discarded.sort()).toEqual(['conflicts/bar.json', REPO_PATH]);
    expect(await makeStore().listEntries(USER)).toEqual([]);
  });

  it('Use theirs: busy while another replica holds the commit lease, and nothing is discarded', async () => {
    const a = await createReplica();
    await a.writeFile(FILE, 'pending');
    const holder = new BlobLease({ accountUrl: ACCOUNT_URL, container: lockContainer(), blobName: `commit-locks/${USER}`, durationSeconds: 15, serviceClient: service });
    expect(await holder.acquireOrRenew()).toBe(true);
    try {
      await expect(a.discardConflictedOverlayEntriesAsync(USER)).rejects.toMatchObject({ code: 'OVERLAY_COMMIT_BUSY' });
      expect((await makeStore().listEntries(USER)).length).toBe(1);
    } finally {
      await holder.release();
    }
  });

  it('Keep mine: re-bases the shared entry onto the branch\'s current blob and commits it over the other change', async () => {
    const a = await createReplica();
    await a.writeFile(FILE, 'mine'); // staged against an absent file
    gh.committed.set(REPO_PATH, blobSha('someone else committed this'));
    expect(await a.commitOverlay(USER, undefined, { branchName: BRANCH })).toMatchObject({ conflictedPaths: [REPO_PATH] });
    // resolveLiveBaseSha reads the branch file; the fake GitHub serves the committed blob's sha.
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if ((init?.method ?? 'GET') === 'GET' && url.includes(`/contents/${REPO_PATH}`)) {
        const c = 'someone else committed this';
        return respond(200, { type: 'file', encoding: 'base64', content: Buffer.from(c).toString('base64'), sha: blobSha(c), size: c.length });
      }
      return realFetch(input as string, init);
    }) as unknown as typeof fetch;
    try {
      const result = await a.rebaseAndRecommitConflictedOverlayEntries(USER, BRANCH);
      expect(result).toMatchObject({ committed: true, stillConflicted: [] });
      expect(gh.committed.get(REPO_PATH)).toBe(blobSha('mine'));
      expect(await makeStore().listEntries(USER)).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // ── t/503 review round (TL t/503#22, SO t/503#21) ───────────────────────────────────────────────

  // N2 / t/685: a commit that landed but was never cleared (a crash after the ref update, a lost response, a failed
  // unstage) leaves entries whose base is the pre-commit blob. They are already on the branch: cleared, not conflicts.
  it('N2: an entry already on the branch (landed, never cleared) is cleared, not reported as a conflict', async () => {
    const a = await createReplica();
    await a.writeFile(FILE, 'landed'); // staged against an absent file
    gh.committed.set(REPO_PATH, blobSha('landed')); // the earlier commit landed; its clear never ran
    const result = await a.commitOverlay(USER, undefined, { branchName: BRANCH });
    expect(result).toBeNull(); // nothing left to commit
    expect(gh.refUpdates).toBe(0);
    expect(await makeStore().listEntries(USER)).toEqual([]);
    expect(a.getUncommittedOverlaySummary()).toEqual([]);
  });

  it('N2: with one landed entry and one pending, only the pending one is committed, and both are cleared', async () => {
    const a = await createReplica();
    await a.writeFile(FILE, 'landed');
    await a.writeFile('/conflicts/bar.json', 'still pending');
    gh.committed.set(REPO_PATH, blobSha('landed'));
    const result = await a.commitOverlay(USER, undefined, { branchName: BRANCH });
    expect(result).toMatchObject({ filesCommitted: 1 });
    expect(result?.conflictedPaths ?? []).toEqual([]);
    expect(committedTreeEntries()).toEqual([expect.objectContaining({ path: 'conflicts/bar.json', content: 'still pending' })]);
    expect(await makeStore().listEntries(USER)).toEqual([]);
  });

  it('N2: a staged delete whose path is already gone from the branch is cleared, not a conflict', async () => {
    gh.committed.set(REPO_PATH, blobSha('old'));
    const a = await createReplica();
    await a.deleteFile(FILE); // staged with base = blobSha('old')
    gh.committed.delete(REPO_PATH); // the delete landed; its clear never ran
    expect(await a.commitOverlay(USER, undefined, { branchName: BRANCH })).toBeNull();
    expect(await makeStore().listEntries(USER)).toEqual([]);
  });

  // B1: A's save sits in A's local map. B commits it and clears the store; then the branch moves on. A must not serve,
  // count or report its stale local copy.
  it('B1: after another replica commits and clears the store, A serves no stale local content and reports nothing uncommitted', async () => {
    const a = await createReplica();
    const b = await createReplica();
    await a.writeFile(FILE, 'X from A');
    expect(await b.commitOverlay(USER, undefined, { branchName: BRANCH })).toMatchObject({ filesCommitted: 1 });
    gh.committed.set(REPO_PATH, blobSha('Y committed later'));
    expect(await a.readFile(FILE)).not.toBe('X from A');
    expect(await a.commitOverlay(USER, undefined, { branchName: BRANCH })).toBeNull();
    expect(a.getUncommittedOverlaySummary()).toEqual([]);
  });

  it('B1: a fresh listing that lacks a path drops A\'s local copy of it', async () => {
    const a = await createReplica();
    const b = await createReplica();
    await a.writeFile(FILE, 'X from A');
    await b.discardConflictedOverlayEntriesAsync(USER); // 'Use theirs' on B clears the store
    expect(await a.readFile(FILE)).not.toBe('X from A');
    expect(a.getUncommittedOverlaySummary()).toEqual([]);
  });

  // Two commits racing on the same branch: the lease lets one through; the other is busy or finds nothing left.
  it('racing commits on two replicas: exactly one commit lands, and the other is busy or finds nothing', async () => {
    const a = await createReplica();
    const b = await createReplica();
    await a.writeFile(FILE, 'pending');
    const outcomes = await Promise.allSettled([
      a.commitOverlay(USER, undefined, { branchName: BRANCH }),
      b.commitOverlay(USER, undefined, { branchName: BRANCH }),
    ]);
    expect(gh.refUpdates).toBe(1);
    const landed = outcomes.filter(o => o.status === 'fulfilled' && o.value?.filesCommitted === 1);
    expect(landed).toHaveLength(1);
    for (const o of outcomes) {
      if (o.status === 'rejected') expect(o.reason, String((o.reason as Error).message)).toMatchObject({ code: 'OVERLAY_COMMIT_BUSY' });
    }
    expect(await makeStore().listEntries(USER)).toEqual([]);
  });

  // The last fence: a commit made outside the lease (another writer on the branch) moves the head between our read and
  // our ref update. The non-forced update is refused (one CAS rejected); nothing is cleared, and the next round commits.
  it('the branch moves under a commit: the non-forced ref update is refused, entries stay, the next commit lands', async () => {
    const a = await createReplica();
    await a.writeFile(FILE, 'pending');
    gh.onTreePost = async () => { gh.head = 'someone-elses-commit'; gh.onTreePost = undefined; };
    await expect(a.commitOverlay(USER, undefined, { branchName: BRANCH })).rejects.toBeTruthy();
    expect(gh.refRejections).toBe(1);
    expect(gh.refUpdates).toBe(0);
    expect((await makeStore().listEntries(USER)).map(e => e.entry.content)).toEqual(['pending']);
    await expect(a.commitOverlay(USER, undefined, { branchName: BRANCH })).resolves.toMatchObject({ filesCommitted: 1 });
    expect(await makeStore().listEntries(USER)).toEqual([]);
  });

  // The store down on the commit path: fails closed, no GitHub write, and the lease is released for the next round.
  it('store down while listing the batch: the commit fails, nothing reaches GitHub, and the lease is released', async () => {
    const a = await createReplica();
    await a.writeFile(FILE, 'pending');
    const spy = vi.spyOn(SharedOverlayStore.prototype, 'listEntries').mockRejectedValueOnce(new Error('simulated store outage'));
    try {
      await expect(a.commitOverlay(USER, undefined, { branchName: BRANCH })).rejects.toThrow(/simulated store outage/);
    } finally {
      spy.mockRestore();
    }
    expect(gh.refUpdates).toBe(0);
    expect(committedTreeEntries()).toEqual([]);
    await expect(a.commitOverlay(USER, undefined, { branchName: BRANCH })).resolves.toMatchObject({ filesCommitted: 1 }); // not busy
  });

  it('commit lock unreachable: the commit fails (not busy, not committed), with no GitHub write', async () => {
    const writer = await createReplica();
    await writer.writeFile(FILE, 'pending');
    const dead = BlobServiceClient.fromConnectionString(CONN.replace(String(PORT), '1'), { retryOptions: { maxTries: 1 } });
    const a = await createReplica({ lockService: dead });
    const err = await a.commitOverlay(USER, undefined, { branchName: BRANCH }).then(() => null, (e: unknown) => e);
    expect(err).toBeTruthy();
    expect(err).not.toMatchObject({ code: 'OVERLAY_COMMIT_BUSY' });
    expect(gh.refUpdates).toBe(0);
    expect((await makeStore().listEntries(USER)).map(e => e.entry.content)).toEqual(['pending']);
  }, 30_000);

  // ── t/552: the DRAINING rollback ──────────────────────────────────────────────────────────────

  it('DRAINING: a save is refused with 503 OVERLAY_DRAINING and nothing is staged or kept locally', async () => {
    const a = await createReplica({ draining: true });
    await expect(a.writeFile(FILE, 'during the drain')).rejects.toMatchObject({ httpStatus: 503, code: 'OVERLAY_DRAINING' });
    await expect(a.deleteFile(FILE)).rejects.toMatchObject({ code: 'OVERLAY_DRAINING' });
    expect(await makeStore().listEntries(USER)).toEqual([]);
    expect(await a.readFile(FILE)).toBeNull();
  });

  it('DRAINING: commits go on, and the drain status counts what is left in the store', async () => {
    const writer = await createReplica();
    await writer.writeFile(FILE, 'pending before the drain');
    writer.setSessionContext({ userId: 'bob', branchName: 'api-session/bob' });
    await writer.writeFile('/conflicts/bob.json', 'bob pending');
    const drainer = await createReplica({ draining: true });
    expect(await drainer.getSharedOverlayDrainStatus()).toEqual({ draining: true, usersWithEntries: [USER, 'bob'].sort(), stagedEntries: 2 });
    expect(await drainer.commitOverlay(USER, undefined, { branchName: BRANCH })).toMatchObject({ filesCommitted: 1 });
    expect(await drainer.getSharedOverlayDrainStatus()).toMatchObject({ usersWithEntries: ['bob'], stagedEntries: 1 });
  });

  it('DRAINING: one drain round commits every user with staged entries and reports the store empty', async () => {
    const writer = await createReplica();
    await writer.writeFile(FILE, 'alice pending');
    writer.setSessionContext({ userId: 'bob', branchName: 'api-session/bob' });
    await writer.writeFile('/conflicts/bob.json', 'bob pending');
    const drainer = await createReplica({ draining: true });
    const fileIO = await import('../storage/fileIO.js');
    const { drainSharedOverlayOnce } = await import('../storage/overlayCommitScheduler.js');
    const previous = fileIO.getBackend();
    fileIO.setBackend(drainer);
    try {
      expect(await drainSharedOverlayOnce()).toEqual({ committed: 2, busy: 0, failed: 0, remainingEntries: 0, remainingUsers: [] });
    } finally {
      fileIO.setBackend(previous);
    }
    expect(gh.committed.get(REPO_PATH)).toBe(blobSha('alice pending'));
    expect(gh.committed.get('conflicts/bob.json')).toBe(blobSha('bob pending'));
  });

  it('DRAINING: a conflicted user stays in the store, listed, until resolved', async () => {
    const writer = await createReplica();
    await writer.writeFile(FILE, 'mine'); // staged against an absent file
    gh.committed.set(REPO_PATH, blobSha('someone else committed this'));
    const drainer = await createReplica({ draining: true });
    const fileIO = await import('../storage/fileIO.js');
    const { drainSharedOverlayOnce } = await import('../storage/overlayCommitScheduler.js');
    const previous = fileIO.getBackend();
    fileIO.setBackend(drainer);
    try {
      expect(await drainSharedOverlayOnce()).toMatchObject({ committed: 0, remainingEntries: 1, remainingUsers: [USER] });
    } finally {
      fileIO.setBackend(previous);
    }
  });

  it('not draining: saves are staged as usual (control)', async () => {
    const a = await createReplica({ draining: false });
    await a.writeFile(FILE, 'normal');
    expect((await a.getSharedOverlayDrainStatus())).toMatchObject({ draining: false, stagedEntries: 1 });
  });
});
