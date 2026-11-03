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
 * Own Azurite port (10007), distinct from every other githubApi- or
 * sharedOverlayStore-prefixed test file's port.
 *
 * LOCAL-ONLY FAILURE MODE (t/2281/t/3444): gated on
 * isUndiciMajorAlignedWithRuntime, same as the other githubApi* test files.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BlobServiceClient } from '@azure/storage-blob';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';
import { SharedOverlayStore } from '../storage/sharedOverlayStore.js';

const UNDICI_ALIGNED = isUndiciMajorAlignedWithRuntime();

const here = path.dirname(fileURLToPath(import.meta.url));
const AZURITE_MAIN = path.resolve(here, '../../../node_modules/azurite/dist/src/blob/main.js');
const PORT = 10007;
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

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — t/4311 follow-up shared overlay read-path + write-through', () => {
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

    replicaA.writeToOverlay('/taxonomy/foo.json', 'from A');

    await waitUntil(() => replicaB.readFile('/taxonomy/foo.json'), v => v === 'from A');
    expect(await replicaB.fileExists('/taxonomy/foo.json')).toBe(true);
    const listing = await waitUntil(() => replicaB.listDirectory('/taxonomy'), v => v.includes('foo.json'));
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

    replicaA.writeToOverlay('/taxonomy/shared.json', 'X (from A)');
    await waitUntil(() => replicaB.readFile('/taxonomy/shared.json'), v => v === 'X (from A)');

    replicaB.writeToOverlay('/taxonomy/shared.json', 'Y (from B)');
    const seenOnA = await waitUntil(() => replicaA.readFile('/taxonomy/shared.json'), v => v !== 'X (from A)');
    expect(seenOnA).toBe('Y (from B)');
  });

  it('a tombstone (delete) on A is eventually visible as absent on B', async () => {
    const storeA = makeStore(prefix);
    const storeB = makeStore(prefix);
    const replicaA = await createReplica(storeA);
    const replicaB = await createReplica(storeB);
    replicaA.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    replicaB.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    replicaA.writeToOverlay('/taxonomy/gone.json', 'will be deleted');
    await waitUntil(() => replicaB.fileExists('/taxonomy/gone.json'), v => v === true);

    await replicaA.deleteFromOverlay('/taxonomy/gone.json', 'api-session/alice');
    await waitUntil(() => replicaB.fileExists('/taxonomy/gone.json'), v => v === false);
    expect(await replicaB.readFile('/taxonomy/gone.json')).toBeNull();
  });

  // Caught during implementation (t/4311#29/#31's posted design didn't call
  // this out): writeThroughSharedOverlay is fire-and-forget, so a replica's
  // read-your-own-write must not depend on that round trip completing.
  it('a replica reads back its own just-written content immediately, with no await on the write-through', async () => {
    const store = makeStore(prefix);
    const replica = await createReplica(store);
    replica.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });

    replica.writeToOverlay('/taxonomy/own-write.json', 'written just now');
    // No await between the write above and the read below beyond what
    // readFile itself performs — if the shared store were trusted blindly
    // (no per-path local fallback), this would race the _gen bump network
    // call and could return null.
    expect(await replica.readFile('/taxonomy/own-write.json')).toBe('written just now');
  });

  it('two different users\' overlays never leak into each other via the shared store', async () => {
    const store = makeStore(prefix);
    const replicaA = await createReplica(store);
    const replicaB = await createReplica(store);
    replicaA.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    replicaB.setSessionContext({ userId: 'bob', branchName: 'api-session/bob' });

    replicaA.writeToOverlay('/taxonomy/alice-only.json', 'alice content');
    await waitUntil(() => replicaA.readFile('/taxonomy/alice-only.json'), v => v === 'alice content');

    expect(await replicaB.fileExists('/taxonomy/alice-only.json')).toBe(false);
  });
});
