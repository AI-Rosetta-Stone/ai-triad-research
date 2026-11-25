// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/550 (t/503 option 2, caller table t/503#15, SO conditions t/503#14): with shared overlay state active, a save is
 * acknowledged only after its stage to the shared store succeeds. Two GitHubAPIBackend instances act as two replicas on
 * one Azurite-backed SharedOverlayStore; `forceActiveForTesting` turns shared state on (it is inert everywhere else).
 *
 * Own Azurite port (10011). Gated on skipForUndiciSkewOutsideCi: skipped only locally, never in CI (TL t/503#22).
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

// TL t/503#22: skips on a dev machine with undici skew only; in CI it always runs, so skew fails it loudly.
const SKIP_LOCAL_SKEW = skipForUndiciSkewOutsideCi();
const here = path.dirname(fileURLToPath(import.meta.url));
const AZURITE_MAIN = path.resolve(here, '../../../node_modules/azurite/dist/src/blob/main.js');
const PORT = 10011;
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

/** The git blob sha GitHub would report for this content. */
function blobSha(content: string): string {
  const buf = Buffer.from(content, 'utf-8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

const headers = { 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) };
function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: new Headers(headers) });
}

/** The session branch's committed content for FILE, or null for 'absent'. */
let branchContent: string | null;

const originalFetch = globalThis.fetch;
beforeEach(() => {
  branchContent = null;
  vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test');
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const p = url.replace('https://api.github.com', '');
    const method = init?.method ?? 'GET';
    if (method === 'GET' && p.includes('/git/refs/heads/')) return respond(200, { object: { sha: 'abc123def456789000000000000000000000dead' } });
    if (method === 'GET' && p.includes('/git/trees/')) return respond(200, { sha: 't', truncated: false, tree: [] });
    if (method === 'GET' && p.includes(`/contents/${REPO_PATH}`) && branchContent !== null) {
      return respond(200, { type: 'file', encoding: 'base64', content: Buffer.from(branchContent).toString('base64'), sha: blobSha(branchContent), size: branchContent.length });
    }
    return respond(404, { message: 'Not Found' });
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

function makeStore(blobPrefix: string): SharedOverlayStore {
  return new SharedOverlayStore({ accountUrl: ACCOUNT_URL, container: CONTAINER, blobPrefix, serviceClient: service });
}

async function createReplica(store: SharedOverlayStore, active = true) {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const backend = new GitHubAPIBackend({
    cacheDir: `/var/cache/taxonomy-test-${++counter}`,
    recorder: { record: vi.fn(), flush: vi.fn(), toJSON: vi.fn().mockReturnValue([]), intern: vi.fn() } as never,
    pollIntervalMs: 999_999_999,
    coherencyProbeRate: 0,
    sharedOverlayState: { store, forceActiveForTesting: active },
  });
  await backend.initialize();
  backend.setSessionContext({ userId: USER, branchName: BRANCH });
  return backend;
}

describe.skipIf(SKIP_LOCAL_SKEW)('GitHubAPIBackend — shared overlay saves are acknowledged only after the stage (t/550)', () => {
  let prefix: string;

  beforeAll(async () => {
    azuriteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-overlay-save-test-'));
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

  beforeEach(() => { prefix = `_test-${++counter}`; });

  it('a save is in the shared store when writeFile resolves (no fire-and-forget)', async () => {
    const store = makeStore(prefix);
    const replica = await createReplica(store);
    await replica.writeFile(FILE, 'v1');
    expect((await store.getEntry(USER, REPO_PATH))?.content).toBe('v1');
    expect((await store.getEntry(USER, REPO_PATH))?.baseSha).toBeNull(); // the branch had no such file
  });

  // TL p/50#161: two tabs (here, two replicas) save one path from the same base. Exactly one is acknowledged.
  it('two-tab race through the backend: two saves from the same baseSha, exactly one acknowledged, the other 409', async () => {
    branchContent = 'committed';
    const base = blobSha('committed');
    const a = await createReplica(makeStore(prefix));
    const b = await createReplica(makeStore(prefix));
    const results = await Promise.allSettled([
      a.writeFile(FILE, 'from tab A', { baseSha: base }),
      b.writeFile(FILE, 'from tab B', { baseSha: base }),
    ]);
    const ok = results.filter(r => r.status === 'fulfilled');
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toMatchObject({ httpStatus: 409, code: 'WRITE_CONFLICT' });
    const winner = results[0].status === 'fulfilled' ? 'from tab A' : 'from tab B';
    expect((await makeStore(prefix).getEntry(USER, REPO_PATH))?.content).toBe(winner);
  });

  // SO t/503#14 condition 2: saves to one path run one at a time on a replica. Two quick saves, X then Y (Y based on X),
  // with the first stage delayed: without the lock, Y's check would run before X is in the store and 409.
  it('delayed first save: X then Y on one replica both succeed, in order, and the store ends with Y', async () => {
    branchContent = 'committed';
    const store = makeStore(prefix);
    const replica = await createReplica(store);
    const realStage = store.stage.bind(store);
    let first = true;
    vi.spyOn(store, 'stage').mockImplementation(async (...args: Parameters<SharedOverlayStore['stage']>) => {
      if (first) { first = false; await new Promise(r => setTimeout(r, 300)); }
      return realStage(...args);
    });
    const x = replica.writeFile(FILE, 'X', { baseSha: blobSha('committed') });
    const y = replica.writeFile(FILE, 'Y', { baseSha: blobSha('X') });
    await expect(Promise.all([x, y])).resolves.toEqual([{ version: blobSha('X') }, { version: blobSha('Y') }]);
    expect((await store.getEntry(USER, REPO_PATH))?.content).toBe('Y');
    expect((await store.getEntry(USER, REPO_PATH))?.baseSha).toBe(blobSha('committed')); // the base of the first stage, kept
  });

  it('a stale baseSha against another replica\'s acknowledged save is a 409', async () => {
    branchContent = 'committed';
    const a = await createReplica(makeStore(prefix));
    const b = await createReplica(makeStore(prefix));
    await a.writeFile(FILE, 'A saved first', { baseSha: blobSha('committed') });
    await expect(b.writeFile(FILE, 'B from the old base', { baseSha: blobSha('committed') }))
      .rejects.toMatchObject({ httpStatus: 409, code: 'WRITE_CONFLICT' });
  });

  it('a stage the store refuses fails the save with a 503, and nothing is acknowledged locally or in the store', async () => {
    const store = makeStore(prefix);
    const replica = await createReplica(store);
    vi.spyOn(store, 'stage').mockResolvedValue({ ok: false, reason: 'storage_unavailable' });
    await expect(replica.writeFile(FILE, 'lost?')).rejects.toMatchObject({ httpStatus: 503, code: 'OVERLAY_STAGE_FAILED' });
    vi.restoreAllMocks();
    expect(await store.getEntry(USER, REPO_PATH)).toBeNull();
    expect(await replica.readFile(FILE)).toBeNull(); // no local-only fallback
  });

  it('writeFileIfAbsent: a path created on another replica is "exists"', async () => {
    const a = await createReplica(makeStore(prefix));
    const b = await createReplica(makeStore(prefix));
    expect(await a.writeFileIfAbsent(FILE, 'created on A')).toBe('created');
    expect(await b.writeFileIfAbsent(FILE, 'created on B')).toBe('exists');
    expect((await makeStore(prefix).getEntry(USER, REPO_PATH))?.content).toBe('created on A');
  });

  it('deleteFile stages a tombstone in the store before it resolves', async () => {
    const store = makeStore(prefix);
    const replica = await createReplica(store);
    await replica.writeFile(FILE, 'to be deleted');
    await replica.deleteFile(FILE);
    expect(await store.getEntry(USER, REPO_PATH)).toMatchObject({ content: null });
  });

  it('flag off: a save stays local and the store is not written synchronously', async () => {
    const store = makeStore(prefix);
    const stageSpy = vi.spyOn(store, 'stage');
    const replica = await createReplica(store, false);
    await replica.writeFile(FILE, 'local only');
    expect(stageSpy).not.toHaveBeenCalled();
    expect(await replica.readFile(FILE)).toBe('local only');
  });
});
