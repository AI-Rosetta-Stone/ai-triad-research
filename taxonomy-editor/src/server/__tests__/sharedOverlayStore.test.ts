// @vitest-environment node

/**
 * t/4311 — SharedOverlayStore (the "(c2)" shared-overlay design, store module
 * only — not wired into githubAPIBackend.ts yet). Azurite-backed, own port
 * (10006) distinct from freePoolBudget.test.ts's 10003 and
 * freePoolBudgetKeyAdmission.test.ts's 10005.
 *
 * Covers the SO's re-confirmation scope for this PR (e/332#8): the overlay
 * store module's stage/unstage/_gen primitives, D1 (unconditional _gen
 * bump), D2 (bump-failure deletes the unacknowledged entry), and S3 (the
 * container is caller-supplied, never a hardcoded default).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BlobServiceClient } from '@azure/storage-blob';
import { SharedOverlayStore, encodePathKey, decodePathKey } from '../storage/sharedOverlayStore.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const AZURITE_MAIN = path.resolve(here, '../../../node_modules/azurite/dist/src/blob/main.js');
const PORT = 10006;
const CONN = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:${PORT}/devstoreaccount1;`;
const ACCOUNT_URL = `http://127.0.0.1:${PORT}/devstoreaccount1`;

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

function makeStore(container: string, blobPrefix: string): SharedOverlayStore {
  return new SharedOverlayStore({ accountUrl: ACCOUNT_URL, container, blobPrefix, serviceClient: service });
}

describe('SharedOverlayStore (Azurite, t/4311 store-module PR)', () => {
  let container: string;

  beforeAll(async () => {
    azuriteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-overlay-store-test-'));
    proc = spawn(
      process.execPath,
      [AZURITE_MAIN, '--silent', '--skipApiVersionCheck', '--location', azuriteDir, '--blobHost', '127.0.0.1', '--blobPort', String(PORT)],
      { stdio: 'ignore', windowsHide: true },
    );
    service = BlobServiceClient.fromConnectionString(CONN);
    await waitForAzurite(service);
    await service.getContainerClient('user-content').createIfNotExists();
    await service.getContainerClient('staging-user-content').createIfNotExists();
  }, 30000);

  afterAll(async () => {
    if (proc) proc.kill();
    try { fs.rmSync(azuriteDir, { recursive: true, force: true }); } catch { /* emulator may still hold a handle */ }
  });

  beforeEach(() => { container = 'user-content'; });

  it('pathKey encoding round-trips and is not a lossy slug (special chars survive)', () => {
    const repoPath = 'taxonomy/acc-beliefs-012.json';
    const key = encodePathKey(repoPath);
    expect(decodePathKey(key)).toBe(repoPath);
    expect(key).not.toContain('/'); // safe as a blob-name segment
  });

  it('stage/getEntry round-trip: content and baseSha survive', async () => {
    const prefix = `_test-${++counter}`;
    const store = makeStore(container, prefix);
    const entry = { content: 'hello world', baseSha: 'abc123', stagedAt: new Date().toISOString() };
    const result = await store.stage('alice', 'taxonomy/foo.json', entry);
    expect(result).toEqual({ ok: true });

    const got = await store.getEntry('alice', 'taxonomy/foo.json');
    expect(got).toEqual(entry);
  });

  it('getEntry returns null for a path never staged', async () => {
    const prefix = `_test-${++counter}`;
    const store = makeStore(container, prefix);
    expect(await store.getEntry('alice', 'taxonomy/never-staged.json')).toBeNull();
  });

  it('unstage removes the entry; getEntry returns null after', async () => {
    const prefix = `_test-${++counter}`;
    const store = makeStore(container, prefix);
    await store.stage('alice', 'taxonomy/foo.json', { content: 'x', baseSha: 'unknown', stagedAt: new Date().toISOString() });
    await store.unstage('alice', 'taxonomy/foo.json');
    expect(await store.getEntry('alice', 'taxonomy/foo.json')).toBeNull();
  });

  it('a staged delete (content: null) is stored and read back as a tombstone, distinct from no entry', async () => {
    const prefix = `_test-${++counter}`;
    const store = makeStore(container, prefix);
    await store.stage('alice', 'taxonomy/foo.json', { content: null, baseSha: 'abc123', stagedAt: new Date().toISOString() });
    const got = await store.getEntry('alice', 'taxonomy/foo.json');
    expect(got).toEqual({ content: null, baseSha: 'abc123', stagedAt: expect.any(String) });
  });

  // D1 (SO e/332#8): the _gen bump must be unconditional, so same-user
  // different-path writes never contend on one ETag.
  it('D1: a concurrent multi-path same-user burst produces 0 _gen-related CAS retries', async () => {
    const prefix = `_test-${++counter}`;
    const store = makeStore(container, prefix);
    const paths = Array.from({ length: 8 }, (_, i) => `taxonomy/doc-${i}.json`);
    const results = await Promise.all(paths.map(p =>
      store.stage('alice', p, { content: `content-${p}`, baseSha: 'unknown', stagedAt: new Date().toISOString() })
    ));
    // All 8 succeed — if the _gen bump were a CAS, a true burst risks
    // exhausting the retry bound and some would fail closed instead.
    expect(results.every(r => r.ok)).toBe(true);
    for (const p of paths) {
      expect(await store.getEntry('alice', p)).toMatchObject({ content: `content-${p}` });
    }
  });

  it('_gen changes on every stage/unstage, observable via getGeneration', async () => {
    const prefix = `_test-${++counter}`;
    const store = makeStore(container, prefix);
    expect(await store.getGeneration('alice')).toBeNull(); // never staged anything yet

    await store.stage('alice', 'taxonomy/foo.json', { content: 'x', baseSha: 'unknown', stagedAt: new Date().toISOString() });
    const gen1 = await store.getGeneration('alice');
    expect(gen1).not.toBeNull();

    await store.stage('alice', 'taxonomy/bar.json', { content: 'y', baseSha: 'unknown', stagedAt: new Date().toISOString() });
    const gen2 = await store.getGeneration('alice');
    expect(gen2).not.toBe(gen1);

    await store.unstage('alice', 'taxonomy/foo.json');
    const gen3 = await store.getGeneration('alice');
    expect(gen3).not.toBe(gen2);
  });

  it('listEntries returns every staged path for a user, never the _gen blob itself', async () => {
    const prefix = `_test-${++counter}`;
    const store = makeStore(container, prefix);
    await store.stage('alice', 'taxonomy/a.json', { content: 'a', baseSha: 'unknown', stagedAt: new Date().toISOString() });
    await store.stage('alice', 'taxonomy/b.json', { content: 'b', baseSha: 'unknown', stagedAt: new Date().toISOString() });
    await store.stage('bob', 'taxonomy/c.json', { content: 'c', baseSha: 'unknown', stagedAt: new Date().toISOString() }); // different user — must not leak in

    const aliceEntries = await store.listEntries('alice');
    expect(aliceEntries).toHaveLength(2);
    expect(aliceEntries.map(e => e.repoPath).sort()).toEqual(['taxonomy/a.json', 'taxonomy/b.json']);
    expect(aliceEntries.some(e => e.pathKey === '_gen')).toBe(false);
  });

  // D2 (SO e/332#8, option (a)): a bump failure deletes the just-written
  // entry rather than leaving an unacknowledged write sitting in the store.
  it('D2: a _gen bump failure deletes the just-written entry and returns storage_unavailable', async () => {
    const prefix = `_test-${++counter}`;
    const store = makeStore(container, prefix);
    // getBlockBlobClient() returns a fresh client object per call, so a spy
    // on one instance never affects the store's own internally-created
    // client. Spy on the shared prototype method instead, conditional on
    // the blob path so only the _gen bump fails — the entry write (a
    // different blob) goes through the real implementation.
    const BlockBlobClientCtor = Object.getPrototypeOf(service.getContainerClient(container).getBlockBlobClient('x')).constructor;
    const realUpload = BlockBlobClientCtor.prototype.upload;
    const uploadSpy = vi.spyOn(BlockBlobClientCtor.prototype, 'upload').mockImplementation(function (this: { name: string }, ...args: unknown[]) {
      if (this.name.endsWith('/_gen')) return Promise.reject(new Error('simulated _gen bump failure'));
      return realUpload.apply(this, args);
    });

    const result = await store.stage('alice', 'taxonomy/foo.json', { content: 'x', baseSha: 'unknown', stagedAt: new Date().toISOString() });
    expect(result).toEqual({ ok: false, reason: 'storage_unavailable' });

    uploadSpy.mockRestore();
    // The entry must not exist — it was deleted after the bump failed.
    expect(await store.getEntry('alice', 'taxonomy/foo.json')).toBeNull();
  });

  // S3: the container is always caller-supplied (environment-scoped at the
  // call site, per AZURE_USER_CONTENT_CONTAINER in server.ts) — never a
  // hardcoded default the class picks on its own regardless of environment.
  it('S3: resolves through the caller-supplied container, not a hardcoded default', async () => {
    const prefix = `_test-${++counter}`;
    const stagingStore = makeStore('staging-user-content', prefix);
    await stagingStore.stage('alice', 'taxonomy/foo.json', { content: 'staging-content', baseSha: 'unknown', stagedAt: new Date().toISOString() });

    // The default-container store must NOT see staging's entry.
    const defaultStore = makeStore('user-content', prefix);
    expect(await defaultStore.getEntry('alice', 'taxonomy/foo.json')).toBeNull();

    // Confirm it actually landed in the staging container, not silently nowhere.
    const direct = await service.getContainerClient('staging-user-content')
      .getBlockBlobClient(`${prefix}/alice/${encodePathKey('taxonomy/foo.json')}.json`)
      .exists();
    expect(direct).toBe(true);
  });

  // Runs last and kills the real Azurite process to simulate "storage
  // unreachable" — a closed port on this network stack doesn't fail fast
  // enough for a sane test timeout (OS-level connect timeout, not a quick
  // ECONNREFUSED), so an unresponsive/dead real endpoint is the reliable way
  // to exercise this path (same pattern as freePoolBudget.test.ts's AC5).
  // No test after this needs Azurite; afterAll's proc.kill() is a safe
  // no-op on an already-dead process.
  it('stage on an unreachable store fails closed (storage_unavailable), never throws', async () => {
    proc.kill();
    const prefix = `_test-${++counter}`;
    const store = makeStore(container, prefix);
    const result = await store.stage('alice', 'taxonomy/foo.json', { content: 'x', baseSha: 'unknown', stagedAt: new Date().toISOString() });
    expect(result).toEqual({ ok: false, reason: 'storage_unavailable' });
  }, 20000);
});
