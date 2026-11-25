// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4311 follow-up (read-path + write-through, t/4311#29/#31, TL-reviewed
 * t/4311#30): two `GitHubAPIBackend` instances simulating two replicas,
 * sharing one Azurite-backed `SharedOverlayStore`. `forceActiveForTesting`
 * bypasses `OVERLAY_SHARED_STATE_COMMIT_READY`'s hardcoded `false` (t/4311#30
 * R2 — inert in every real environment until the commit-path follow-up
 * ships) so this PR's wiring can be exercised before that flag ever flips
 * for real.
 *
 * Own Azurite on a free port per run (azuriteFreePort.ts).
 *
 * LOCAL-ONLY FAILURE MODE (t/2281/t/3444): gated on skipForUndiciSkewOutsideCi, so it skips on a dev
 * machine with undici skew and never in CI (t/687).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { freeAzuritePort } from './azuriteFreePort.js';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BlobServiceClient } from '@azure/storage-blob';
import { skipForUndiciSkewOutsideCi } from '../storage/undiciInvariant.js';
import { SharedOverlayStore } from '../storage/sharedOverlayStore.js';

// t/577: pay githubAPIBackend's cold import here, not inside the first test's timeout. Under the pre-push hook's
// 8 workers the first test in this file timed out at 5-8 s although every test passes alone (TaxonomyServer p/52#36).
beforeAll(async () => { await import('../storage/githubAPIBackend'); }, 60_000);

// t/687 (SO p/269#24, TL t/503#26): skips on a dev machine with undici skew only; in CI it always runs.
const SKIP_LOCAL_SKEW = skipForUndiciSkewOutsideCi();

const here = path.dirname(fileURLToPath(import.meta.url));
const AZURITE_MAIN = path.resolve(here, '../../../node_modules/azurite/dist/src/blob/main.js');
// t/503 (Quality p/58#75): its own emulator per run; the fixed port 10007 let overlapping runs share one.
const PORT = await freeAzuritePort();
const CONN = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:${PORT}/devstoreaccount1;`;
const ACCOUNT_URL = `http://127.0.0.1:${PORT}/devstoreaccount1`;
const CONTAINER = 'user-content';

let proc: ChildProcess;
let service: BlobServiceClient;
let azuriteDir: string;
let counter = 0;

async function waitForAzurite(svc: BlobServiceClient, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try { await svc.getProperties(); return; }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error(`Azurite did not become ready: ${String(lastErr)}`);
}

vi.mock('fs/promises', () => ({
  default: {
    realpath: vi.fn(async (p: string) => p), // t/432: confineToDir resolves real paths
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

const defaultRateLimitHeaders = {
  'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000',
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
};

function mockFetchResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: new Headers(defaultRateLimitHeaders) });
}

const MAIN_SHA = 'abc123def456789000000000000000000000dead';
const TREE_SHA = 'tree-sha-000000000000000000000000000dead';

function handleDefaultGithubApi(url: string, method: string): Response {
  const p = url.replace('https://api.github.com', '');
  if (method === 'GET' && p.includes('/git/refs/heads/')) return mockFetchResponse(200, { object: { sha: MAIN_SHA } });
  if (method === 'GET' && p.includes('/git/trees/')) return mockFetchResponse(200, { sha: TREE_SHA, truncated: false, tree: [] });
  return mockFetchResponse(404, { message: 'Not Found' });
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test');
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    return handleDefaultGithubApi(url, method);
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

function makeStore(blobPrefix: string): SharedOverlayStore {
  return new SharedOverlayStore({ accountUrl: ACCOUNT_URL, container: CONTAINER, blobPrefix, serviceClient: service });
}

async function createReplica(store: SharedOverlayStore) {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const backend = new GitHubAPIBackend({
    cacheDir: `/var/cache/taxonomy-test-${++counter}`,
    recorder: { record: vi.fn(), flush: vi.fn(), toJSON: vi.fn().mockReturnValue([]), intern: vi.fn() } as never,
    pollIntervalMs: 999_999_999,
    coherencyProbeRate: 0,
    sharedOverlayState: { store, forceActiveForTesting: true },
  });
  await backend.initialize();
  return backend;
}

/** The write-through is fire-and-forget, so a cross-replica assertion must
 *  poll rather than assume one microtask is enough. Bounded — fails loudly
 *  (not silently) if the write never becomes visible. */
async function waitUntil<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (predicate(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil timed out; last value: ${JSON.stringify(v)}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

describe.skipIf(SKIP_LOCAL_SKEW)('GitHubAPIBackend — t/4311 follow-up shared overlay read-path + write-through', () => {
  let prefix: string;

  beforeAll(async () => {
    azuriteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-overlay-readpath-test-'));
    proc = spawn(
      process.execPath,
      [AZURITE_MAIN, '--silent', '--skipApiVersionCheck', '--location', azuriteDir, '--blobHost', '127.0.0.1', '--blobPort', String(PORT)],
      { stdio: 'ignore', windowsHide: true },
    );
    service = BlobServiceClient.fromConnectionString(CONN);
    await waitForAzurite(service);
    await service.getContainerClient(CONTAINER).createIfNotExists();
  }, 30000);

  afterAll(async () => {
    if (proc) proc.kill();
    try { fs.rmSync(azuriteDir, { recursive: true, force: true }); } catch { /* emulator may still hold a handle */ }
  });

  beforeEach(() => { prefix = `_test-${++counter}`; });

  it('a write on replica A becomes visible to replica B\'s readFile/fileExists/listDirectory', async () => {
    const storeA = makeStore(prefix);
    const storeB = makeStore(prefix);
    const replicaA = await createReplica(storeA);
    const replicaB = await createReplica(storeB);
    replicaA.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    replicaB.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    await replicaA.writeFile('/conflicts/foo.json', 'from A');

    await waitUntil(() => replicaB.readFile('/conflicts/foo.json'), v => v === 'from A');
    expect(await replicaB.fileExists('/conflicts/foo.json')).toBe(true);
    const listing = await waitUntil(() => replicaB.listDirectory('/conflicts'), v => v.includes('foo.json'));
    expect(listing).toContain('foo.json');
  });

  // TL's exact R1 scenario (t/4311#30): a stale local hit must not win over
  // a newer cross-replica write.
  it('R1: write X on A, write Y on B to the same path, read on A returns Y (not stale X)', async () => {
    const storeA = makeStore(prefix);
    const storeB = makeStore(prefix);
    const replicaA = await createReplica(storeA);
    const replicaB = await createReplica(storeB);
    replicaA.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    replicaB.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    await replicaA.writeFile('/conflicts/shared.json', 'X (from A)');
    await waitUntil(() => replicaB.readFile('/conflicts/shared.json'), v => v === 'X (from A)');

    await replicaB.writeFile('/conflicts/shared.json', 'Y (from B)');
    const seenOnA = await waitUntil(() => replicaA.readFile('/conflicts/shared.json'), v => v !== 'X (from A)');
    expect(seenOnA).toBe('Y (from B)');
  });

  it('a tombstone (delete) on A is eventually visible as absent on B', async () => {
    const storeA = makeStore(prefix);
    const storeB = makeStore(prefix);
    const replicaA = await createReplica(storeA);
    const replicaB = await createReplica(storeB);
    replicaA.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    replicaB.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    await replicaA.writeFile('/conflicts/gone.json', 'will be deleted');
    await waitUntil(() => replicaB.fileExists('/conflicts/gone.json'), v => v === true);

    await replicaA.deleteFromOverlay('/conflicts/gone.json', 'api-session/alice');
    await waitUntil(() => replicaB.fileExists('/conflicts/gone.json'), v => v === false);
    expect(await replicaB.readFile('/conflicts/gone.json')).toBeNull();
  });

  // t/503 option 2: the save is acknowledged once staged, so the read-back comes from the store, never a local fallback
  // (the fire-and-forget write-through that needed one is gone).
  it('a replica reads back its own just-acknowledged save', async () => {
    const store = makeStore(prefix);
    const replica = await createReplica(store);
    replica.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    await replica.writeFile('/conflicts/own-write.json', 'written just now');
    expect(await replica.readFile('/conflicts/own-write.json')).toBe('written just now');
  });

  // t/549 (SO t/503#10): a stage whose `_gen` bump failed is still acknowledged, so a reader must not trust an
  // unchanged `_gen` forever. It re-lists once its listing is older than SHARED_OVERLAY_RELIST_MS.
  it('t/549: a save whose _gen bump failed becomes visible on another replica at the periodic re-list', async () => {
    const { SHARED_OVERLAY_RELIST_MS } = await import('../storage/githubAPIBackend');
    const storeA = makeStore(prefix);
    const replicaB = await createReplica(makeStore(prefix));
    replicaB.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    await storeA.stage('alice', 'conflicts/seed.json', { content: 'seed', baseSha: null, stagedAt: new Date().toISOString(), stageId: 'seed-1' }, { absent: true });
    expect(await replicaB.readFile('/conflicts/seed.json')).toBe('seed'); // B has listed at this generation

    const ctor = Object.getPrototypeOf(service.getContainerClient(CONTAINER).getBlockBlobClient('x')).constructor;
    const realUpload = ctor.prototype.upload;
    const spy = vi.spyOn(ctor.prototype, 'upload').mockImplementation(function (this: { name: string }, ...args: unknown[]) {
      return this.name.endsWith('/_gen') ? Promise.reject(new Error('simulated _gen bump failure')) : realUpload.apply(this, args);
    });
    const r = await storeA.stage('alice', 'conflicts/late.json', { content: 'late', baseSha: null, stagedAt: new Date().toISOString(), stageId: 'late-1' }, { absent: true });
    spy.mockRestore();
    expect(r).toMatchObject({ ok: true, genBumped: false });

    // Same generation and a fresh listing: B still serves its cached listing.
    expect(await replicaB.fileExists('/conflicts/late.json')).toBe(false);

    const realNow = Date.now.bind(Date);
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + SHARED_OVERLAY_RELIST_MS + 1_000);
    try {
      expect(await replicaB.readFile('/conflicts/late.json')).toBe('late');
    } finally {
      nowSpy.mockRestore();
    }
  });

  // SO t/503#21: with shared state active, a local-only overlay write would never be seen or committed, so it is refused.
  it('writeToOverlay is refused while shared state is active; nothing is staged or served', async () => {
    const store = makeStore(prefix);
    const replica = await createReplica(store);
    replica.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    expect(() => replica.writeToOverlay('/conflicts/local-only.json', 'never saved')).toThrow(expect.objectContaining({ code: 'OVERLAY_LOCAL_WRITE_REFUSED' }));
    expect(await store.listEntries('alice')).toEqual([]);
    expect(await replica.readFile('/conflicts/local-only.json')).toBeNull();
  });

  it('two different users\' overlays never leak into each other via the shared store', async () => {
    const store = makeStore(prefix);
    const replicaA = await createReplica(store);
    const replicaB = await createReplica(store);
    replicaA.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    replicaB.setSessionContext({ userId: 'bob', branchName: 'api-session/bob' });

    await replicaA.writeFile('/conflicts/alice-only.json', 'alice content');
    await waitUntil(() => replicaA.readFile('/conflicts/alice-only.json'), v => v === 'alice content');

    expect(await replicaB.fileExists('/conflicts/alice-only.json')).toBe(false);
  });
});
