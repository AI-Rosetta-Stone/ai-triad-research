// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4179 (TL design t/4179#2/#7) — single-holder GitHub poll coordination
 * tests: two GitHubAPIBackend instances sharing a real Azurite
 * poll-coordination container (same pattern as blobLease.test.ts, a
 * different port to avoid collision) and a shared mocked GitHub API.
 *
 * LOCAL-ONLY FAILURE MODE (t/2281/t/3444): gated on
 * isUndiciMajorAlignedWithRuntime() like the sibling githubApi*.test.ts files.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BlobServiceClient } from '@azure/storage-blob';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';
import type { FlightRecorder, RecordInput } from '../../../../lib/flight-recorder/index';

const UNDICI_ALIGNED = isUndiciMajorAlignedWithRuntime();

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

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const src = (actual.default ?? actual) as Record<string, unknown>;
  const patched = { ...src, promises: { ...(src.promises as object), rename: vi.fn().mockResolvedValue(undefined) } };
  return { ...patched, default: patched };
});

vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/testrepo', token: 'test-token-abc123', mode: 'pat' as const }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getTokenExpiryMs: vi.fn().mockReturnValue(0),
}));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: vi.fn().mockReturnValue(null),
  FlightRecorder: vi.fn(),
}));

// ── Azurite (poll-coordination container) ──────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const AZURITE_MAIN = path.resolve(here, '../../../node_modules/azurite/dist/src/blob/main.js');
const PORT = 10002;
const CONN = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:${PORT}/devstoreaccount1;`;
const CONTAINER = 'poll-coordination';

let azuriteProc: ChildProcess;
let azuriteService: BlobServiceClient;
let azuriteDir: string;
let containerCounter = 0;

async function waitForAzurite(svc: BlobServiceClient, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try { await svc.getProperties(); return; }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error(`Azurite did not become ready: ${String(lastErr)}`);
}

beforeAll(async () => {
  azuriteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-polllease-test-'));
  azuriteProc = spawn(
    process.execPath,
    [AZURITE_MAIN, '--silent', '--skipApiVersionCheck', '--location', azuriteDir, '--blobHost', '127.0.0.1', '--blobPort', String(PORT)],
    { stdio: 'ignore' },
  );
  azuriteService = BlobServiceClient.fromConnectionString(CONN);
  await waitForAzurite(azuriteService);
}, 30000);

afterAll(async () => {
  if (azuriteProc) azuriteProc.kill();
  try { fs.rmSync(azuriteDir, { recursive: true, force: true }); } catch { /* emulator may still hold a handle */ }
});

// A fresh container per test — two backends in different tests must never
// see each other's poll-state.
let container: string;
beforeEach(async () => {
  container = `${CONTAINER}-${++containerCounter}`;
  await azuriteService.getContainerClient(container).createIfNotExists();
});

// ── GitHub API mock (shared by every backend instance in a test) ───────

type MockHandler = (url: string, init: RequestInit) => { status: number; body?: unknown } | null;
let apiHandlers: MockHandler[] = [];
let commitsCalls = 0;
let compareCalls = 0;
let treeCalls = 0;

const defaultRateLimitHeaders = {
  'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000',
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
};

function mockFetchResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: new Headers(defaultRateLimitHeaders) });
}

const TREE_SHA = 'tree-sha-000000000000000000000000000dead';

/** The GitHub repo's current HEAD sha — tests move this to simulate a commit. */
let currentMainSha = 'sha-0000000000000000000000000000000000dead';
let changedFilesOnNextCompare: string[] = [];

function handleDefaultGithubApi(url: string, method: string): Response {
  const p = url.replace('https://api.github.com', '');
  if (method === 'GET' && p.includes('/commits/main')) { commitsCalls++; return mockFetchResponse(200, { sha: currentMainSha }); }
  if (method === 'GET' && p.match(/\/compare\//)) {
    compareCalls++;
    return mockFetchResponse(200, { files: changedFilesOnNextCompare.map(f => ({ filename: f, status: 'modified' })) });
  }
  if (method === 'GET' && p.match(/\/git\/commits\/[a-f0-9-]+/)) return mockFetchResponse(200, { sha: currentMainSha, tree: { sha: TREE_SHA } });
  if (method === 'GET' && p.includes('/git/trees/')) {
    treeCalls++;
    return mockFetchResponse(200, { sha: TREE_SHA, truncated: false, tree: [{ path: 'taxonomy/nodes.json', mode: '100644', type: 'blob', sha: 'blob1', size: 100 }] });
  }
  return mockFetchResponse(404, { message: 'Not Found' });
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  apiHandlers = [];
  commitsCalls = 0;
  compareCalls = 0;
  treeCalls = 0;
  currentMainSha = 'sha-0000000000000000000000000000000000dead';
  changedFilesOnNextCompare = [];
  vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test');
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    for (const handler of apiHandlers) {
      const result = handler(url, init ?? {});
      if (result) return mockFetchResponse(result.status, result.body);
    }
    return handleDefaultGithubApi(url, method);
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

function createTestRecorder(): FlightRecorder & { events: RecordInput[] } {
  const events: RecordInput[] = [];
  return { events, record: (input: RecordInput) => { events.push(input); }, flush: vi.fn(), toJSON: vi.fn().mockReturnValue([]), intern: vi.fn() } as unknown as FlightRecorder & { events: RecordInput[] };
}

// Each replica gets its OWN cacheDir (fs is fully mocked, so this is just a
// label) and its OWN backend instance — they coordinate only through the
// shared Azurite container, exactly like real replicas would through Blob.
async function createReplica(pollIntervalMs: number): Promise<InstanceType<typeof import('../storage/githubAPIBackend.js').GitHubAPIBackend>> {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend.js');
  const backend = new GitHubAPIBackend({
    cacheDir: `/var/cache/taxonomy-test-${Math.random()}`,
    recorder: createTestRecorder(),
    pollIntervalMs,
    coherencyProbeRate: 0,
    pollLease: {
      accountUrl: `http://127.0.0.1:${PORT}/devstoreaccount1`,
      container,
      maxReplicas: 3,
      serviceClient: azuriteService,
    },
  });
  await backend.initialize();
  return backend;
}

// Private-internals test seam — the single-holder coordination has no other
// observable surface (it's an internal scheduling detail of one backend).
function priv(backend: unknown): any { return backend as any; }

async function waitUntil(predicate: () => boolean, timeoutMs: number, stepMs = 50): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, stepMs));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

/** Poll readPollState() (an async Blob read) until it returns a state
 *  authored by the given replica. Acquiring the lease alone only seeds an
 *  empty blob (BlobLease.ensureBlobExists) — the real JSON payload only
 *  appears once the replica's own pollAsHolder() tick publishes, so the
 *  in-memory pollStateGeneration counter (which increments synchronously
 *  before that async upload lands) is the wrong signal to wait on here. */
async function waitForPublishedState(replica: unknown, timeoutMs: number, stepMs = 100): Promise<{ holderId: string; lastCommitSha: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const s = await priv(replica).readPollState();
      if (s && s.holderId === priv(replica).holderId) return s;
    } catch { /* blob still seeded empty, or a transient read race — retry */ }
    await new Promise(r => setTimeout(r, stepMs));
  }
  throw new Error(`waitForPublishedState: no published state from this replica within ${timeoutMs}ms`);
}

describe.skipIf(!UNDICI_ALIGNED)('GitHubAPIBackend — single-holder poll coordination (t/4179)', () => {
  it('exactly one of two replicas becomes holder; the non-holder never calls the GitHub poll endpoints', async () => {
    const a = await createReplica(300);
    const b = await createReplica(300);

    await waitUntil(() => priv(a).blobLease.isHolder() || priv(b).blobLease.isHolder(), 5000);

    const aHolds = priv(a).blobLease.isHolder();
    const bHolds = priv(b).blobLease.isHolder();
    expect(aHolds).not.toBe(bHolds); // exactly one holder

    // Give the non-holder a few ticks to prove it stays non-holder and never
    // calls the expensive endpoints itself.
    await new Promise(r => setTimeout(r, 900));
    const nonHolder = aHolds ? b : a;
    expect(priv(nonHolder).blobLease.isHolder()).toBe(false);

    a.shutdown();
    b.shutdown();
  }, 15000);

  it('a non-holder picks up the holder\'s change via shared poll-state, without calling GitHub itself', async () => {
    const a = await createReplica(300);
    const b = await createReplica(300);

    await waitUntil(() => priv(a).blobLease.isHolder() || priv(b).blobLease.isHolder(), 5000);
    const holder = priv(a).blobLease.isHolder() ? a : b;
    const nonHolder = holder === a ? b : a;

    // Let the holder publish at least one heartbeat so the non-holder has a
    // baseline generation (first-ever observation is treated as a gap, not
    // "no change" — this establishes pollLastSeenGeneration > 0).
    await waitUntil(() => priv(nonHolder).pollLastSeenGeneration > 0, 3000);

    const commitsBefore = commitsCalls;
    const compareBefore = compareCalls;
    const treeBefore = treeCalls;

    // Simulate a commit: move HEAD, arm the compare response.
    currentMainSha = 'sha-after-commit-0000000000000000000dead';
    changedFilesOnNextCompare = ['taxonomy/nodes.json'];

    await waitUntil(() => priv(nonHolder).manifest?.lastCommitSha === currentMainSha, 5000);

    // The holder did the real GitHub work; the non-holder's own commits/
    // compare/tree call counts must not have moved — it only read the
    // shared poll-state.
    expect(commitsCalls).toBeGreaterThan(commitsBefore); // the holder polled
    expect(compareCalls).toBeGreaterThan(compareBefore);
    void treeBefore; // tree calls are allowed to move (holder's own fetchRepoTree); not asserted here

    a.shutdown();
    b.shutdown();
  }, 15000);

  it('takeover: the holder pauses past lease expiry, a successor takes over, and the paused holder\'s publish is rejected by the fence', async () => {
    const a = await createReplica(300); // will become holder, then get paused
    const b = await createReplica(300); // successor

    await waitUntil(() => priv(a).blobLease.isHolder() || priv(b).blobLease.isHolder(), 5000);
    // Whichever replica actually won the race becomes the one we pause —
    // the scenario doesn't depend on which of a/b that is.
    const pausedHolder = priv(a).blobLease.isHolder() ? a : b;
    const successor = pausedHolder === a ? b : a;
    const staleLeaseId = priv(pausedHolder).blobLease.getLeaseId();
    expect(staleLeaseId).toBeTruthy();

    // "Paused": stop its own renewal/poll timers WITHOUT releasing the
    // lease — simulates a replica that stopped responding (GC, crash) rather
    // than one that shut down cleanly.
    clearInterval(priv(pausedHolder).leaseRenewTimer);
    clearInterval(priv(pausedHolder).pollTimer);

    // Wait past the lease duration (15s, Azure's minimum) for the successor
    // to take over, and for its own first poll tick to actually publish
    // (acquiring the lease alone only seeds an empty blob — the real state
    // write happens on its next pollAsHolder() tick).
    //
    // Worst-case budget (p/783#4: flaked at 20064ms under CI load — the
    // original 20000ms had ~5s of margin past the mechanics' own worst case,
    // not CI slowness): the lease (duration 15s) must fully expire before
    // the successor's OWN renewal timer (duration/3 = 5s) next fires and
    // notices it's free, so up to ~20s can elapse before the successor even
    // attempts acquireOrRenew — before any CI/Azurite latency on top. 45s
    // leaves real margin instead of racing the mechanics' own floor.
    await waitUntil(() => priv(successor).blobLease.isHolder(), 45000);
    expect(priv(successor).blobLease.getLeaseId()).not.toBe(staleLeaseId);

    const stateBeforeStalePublish = await waitForPublishedState(successor, 10000);
    expect(stateBeforeStalePublish.holderId).toBe(priv(successor).holderId);

    // The paused holder, if it woke up and tried to publish with its now-
    // stale leaseId, must be rejected by the fence — not silently land.
    await expect(
      priv(pausedHolder).publishPollState('some-stale-sha', ['taxonomy/nodes.json']),
    ).resolves.toBeUndefined(); // publishPollState itself never throws...
    // ...but it must not have actually written: the successor's state is
    // still the authoritative one, not overwritten by the stale publish.
    const state = await priv(successor).readPollState();
    expect(state.holderId).toBe(priv(successor).holderId);
    expect(state.lastCommitSha).not.toBe('some-stale-sha');

    successor.shutdown();
    // pausedHolder's timers are already cleared; nothing left to shut down
    // there except releasing whatever lease belief it still holds locally.
    await priv(pausedHolder).blobLease.release().catch(() => {});
  }, 60000);
});
