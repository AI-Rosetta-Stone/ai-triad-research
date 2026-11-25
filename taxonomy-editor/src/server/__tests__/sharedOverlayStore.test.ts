// @vitest-environment node

/**
 * t/4311 — SharedOverlayStore (the "(c2)" shared-overlay design, store module
 * only — not wired into githubAPIBackend.ts yet). Azurite-backed, own port
 * (10006) distinct from freePoolBudget.test.ts's 10003 and
 * freePoolBudgetKeyAdmission.test.ts's 10005.
 *
 * Covers the SO's re-confirmation scope for this PR (e/332#8): the overlay
 * store module's stage/unstage/_gen primitives, D1 (unconditional _gen
 * bump), and S3 (the container is caller-supplied, never a hardcoded default).
 * t/549 replaced D2/E1/F2 (delete on a failed bump) with "the conditional
 * upload is the acknowledgment"; its tests are in the t/549 describe below.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { BlobServiceClient, RestError } from '@azure/storage-blob';
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

const LW = { latestWins: true } as const;
function withId<T extends object>(e: T): T & { stageId: string } { return { ...e, stageId: randomUUID() }; }

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
    const entry = withId({ content: 'hello world', baseSha: 'abc123', stagedAt: new Date().toISOString() });
    const result = await store.stage('alice', 'taxonomy/foo.json', entry, LW);
    expect(result.ok).toBe(true);
    expect((result as { gen: string }).gen).toEqual(expect.any(String));

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
    await store.stage('alice', 'taxonomy/foo.json', withId({ content: 'x', baseSha: 'unknown', stagedAt: new Date().toISOString() }), LW);
    await store.unstage('alice', 'taxonomy/foo.json');
    expect(await store.getEntry('alice', 'taxonomy/foo.json')).toBeNull();
  });

  it('a staged delete (content: null) is stored and read back as a tombstone, distinct from no entry', async () => {
    const prefix = `_test-${++counter}`;
    const store = makeStore(container, prefix);
    await store.stage('alice', 'taxonomy/foo.json', withId({ content: null, baseSha: 'abc123', stagedAt: new Date().toISOString() }), LW);
    const got = await store.getEntry('alice', 'taxonomy/foo.json');
    expect(got).toEqual({ content: null, baseSha: 'abc123', stagedAt: expect.any(String), stageId: expect.any(String) });
  });

  // D1 (SO e/332#8): the _gen bump must be unconditional, so same-user
  // different-path writes never contend on one ETag.
  it('D1: a concurrent multi-path same-user burst produces 0 _gen-related CAS retries', async () => {
    const prefix = `_test-${++counter}`;
    const store = makeStore(container, prefix);
    const paths = Array.from({ length: 8 }, (_, i) => `taxonomy/doc-${i}.json`);
    const results = await Promise.all(paths.map(p =>
      store.stage('alice', p, withId({ content: `content-${p}`, baseSha: 'unknown', stagedAt: new Date().toISOString() }), LW)
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

    await store.stage('alice', 'taxonomy/foo.json', withId({ content: 'x', baseSha: 'unknown', stagedAt: new Date().toISOString() }), LW);
    const gen1 = await store.getGeneration('alice');
    expect(gen1).not.toBeNull();

    await store.stage('alice', 'taxonomy/bar.json', withId({ content: 'y', baseSha: 'unknown', stagedAt: new Date().toISOString() }), LW);
    const gen2 = await store.getGeneration('alice');
    expect(gen2).not.toBe(gen1);

    await store.unstage('alice', 'taxonomy/foo.json');
    const gen3 = await store.getGeneration('alice');
    expect(gen3).not.toBe(gen2);
  });

  it('listEntries returns every staged path for a user, never the _gen blob itself', async () => {
    const prefix = `_test-${++counter}`;
    const store = makeStore(container, prefix);
    await store.stage('alice', 'taxonomy/a.json', withId({ content: 'a', baseSha: 'unknown', stagedAt: new Date().toISOString() }), LW);
    await store.stage('alice', 'taxonomy/b.json', withId({ content: 'b', baseSha: 'unknown', stagedAt: new Date().toISOString() }), LW);
    await store.stage('bob', 'taxonomy/c.json', withId({ content: 'c', baseSha: 'unknown', stagedAt: new Date().toISOString() }), LW); // different user — must not leak in

    const aliceEntries = await store.listEntries('alice');
    expect(aliceEntries).toHaveLength(2);
    expect(aliceEntries.map(e => e.repoPath).sort()).toEqual(['taxonomy/a.json', 'taxonomy/b.json']);
    expect(aliceEntries.some(e => e.pathKey === '_gen')).toBe(false);
  });

  // E3 (SO e/332#10): listEntries carries ETags, and unstage(ifMatch) must
  // report 'changed' rather than deleting a write newer than the caller's
  // snapshot — the primitive the (separate, follow-up-PR) commit path needs
  // for S2's "clear only if unchanged" semantics.
  it('E3: listEntries returns ETags, and unstage(ifMatch) reports "changed" instead of deleting a newer write', async () => {
    const prefix = `_test-${++counter}`;
    const store = makeStore(container, prefix);
    await store.stage('alice', 'taxonomy/foo.json', withId({ content: 'v1', baseSha: 'unknown', stagedAt: new Date().toISOString() }), LW);
    const [staleEntry] = await store.listEntries('alice');
    expect(typeof staleEntry.etag).toBe('string');
    expect(staleEntry.etag.length).toBeGreaterThan(0);

    // Someone else restages the same path, changing its ETag.
    await store.stage('alice', 'taxonomy/foo.json', withId({ content: 'v2', baseSha: 'unknown', stagedAt: new Date().toISOString() }), LW);

    // unstage with the now-STALE etag must report 'changed', not delete.
    const staleResult = await store.unstage('alice', 'taxonomy/foo.json', { ifMatch: staleEntry.etag });
    expect(staleResult).toBe('changed');
    expect(await store.getEntry('alice', 'taxonomy/foo.json')).toMatchObject({ content: 'v2' });

    // unstage with the CURRENT etag does delete.
    const [currentEntry] = await store.listEntries('alice');
    const currentResult = await store.unstage('alice', 'taxonomy/foo.json', { ifMatch: currentEntry.etag });
    expect(currentResult).toBe('deleted');
    expect(await store.getEntry('alice', 'taxonomy/foo.json')).toBeNull();
  });

  // F1 (SO e/332#12): a genuine delete failure (not a 412) must report
  // 'failed', never 'deleted' — a caller that believed a stale entry was
  // cleared would otherwise trip the (separate, follow-up-PR) commit path's
  // t/4312 fence as a false conflict on the user's own committed edit.
  it('F1: a genuine delete failure returns "failed", not "deleted"', async () => {
    const prefix = `_test-${++counter}`;
    const store = makeStore(container, prefix);
    await store.stage('alice', 'taxonomy/foo.json', withId({ content: 'v1', baseSha: 'unknown', stagedAt: new Date().toISOString() }), LW);

    const client = service.getContainerClient(container).getBlockBlobClient(`${prefix}/alice/${encodePathKey('taxonomy/foo.json')}.json`);
    const BlockBlobClientCtor = Object.getPrototypeOf(client).constructor;
    const deleteSpy = vi.spyOn(BlockBlobClientCtor.prototype, 'deleteIfExists').mockRejectedValue(new Error('simulated genuine delete failure'));

    const result = await store.unstage('alice', 'taxonomy/foo.json');
    expect(result).toBe('failed');

    deleteSpy.mockRestore();
    // The entry must still be there — the delete genuinely never happened.
    expect(await store.getEntry('alice', 'taxonomy/foo.json')).toMatchObject({ content: 'v1' });
  });

  // S3: the container is always caller-supplied (environment-scoped at the
  // call site, per AZURE_USER_CONTENT_CONTAINER in server.ts) — never a
  // hardcoded default the class picks on its own regardless of environment.
  it('S3: resolves through the caller-supplied container, not a hardcoded default', async () => {
    const prefix = `_test-${++counter}`;
    const stagingStore = makeStore('staging-user-content', prefix);
    await stagingStore.stage('alice', 'taxonomy/foo.json', withId({ content: 'staging-content', baseSha: 'unknown', stagedAt: new Date().toISOString() }), LW);

    // The default-container store must NOT see staging's entry.
    const defaultStore = makeStore('user-content', prefix);
    expect(await defaultStore.getEntry('alice', 'taxonomy/foo.json')).toBeNull();

    // Confirm it actually landed in the staging container, not silently nowhere.
    const direct = await service.getContainerClient('staging-user-content')
      .getBlockBlobClient(`${prefix}/alice/${encodePathKey('taxonomy/foo.json')}.json`)
      .exists();
    expect(direct).toBe(true);
  });

  // ── t/549 (t/503 PR 1): the conditional upload is the acknowledgment ──────────────────────────

  const FOO = 'taxonomy/foo.json';

  /** Spy on every BlockBlobClient upload (each call makes a fresh client, so spy on the prototype). */
  function spyUploads(impl: (self: { name: string }, real: (...a: unknown[]) => Promise<unknown>, args: unknown[]) => Promise<unknown>) {
    const ctor = Object.getPrototypeOf(service.getContainerClient(container).getBlockBlobClient('x')).constructor;
    const real = ctor.prototype.upload;
    return vi.spyOn(ctor.prototype, 'upload').mockImplementation(function (this: { name: string }, ...args: unknown[]) {
      return impl(this, (...a: unknown[]) => real.apply(this, a), args);
    });
  }

  function entryAt(content: string | null, stagedAt: string, baseSha: string | null | 'unknown' = 'base0') {
    return { content, baseSha, stagedAt, stageId: randomUUID() };
  }

  describe('t/549: acknowledgment semantics', () => {
    it('SO test 1: a failed _gen bump still acknowledges the save, and the entry is listed (no delete)', async () => {
      const store = makeStore(container, `_test-${++counter}`);
      const spy = spyUploads((self, real, args) => self.name.endsWith('/_gen') ? Promise.reject(new Error('simulated _gen bump failure')) : real(...args));
      const result = await store.stage('alice', FOO, entryAt('x', new Date().toISOString()), { absent: true });
      spy.mockRestore();
      expect(result).toMatchObject({ ok: true, genBumped: false, gen: null, etag: expect.any(String) });
      expect((await store.listEntries('alice')).map(e => e.entry.content)).toEqual(['x']);
    });

    it('SO test 2: a definitely failed upload leaves the previous acknowledged value intact', async () => {
      const store = makeStore(container, `_test-${++counter}`);
      await store.stage('alice', FOO, entryAt('v1', new Date().toISOString()), { absent: true });
      const prev = (await store.getEntryWithEtag('alice', FOO))!;
      const spy = spyUploads((self, real, args) => self.name.endsWith('.json')
        ? Promise.reject(new RestError('simulated 403', { statusCode: 403 }))
        : real(...args));
      const result = await store.stage('alice', FOO, entryAt('v2', new Date().toISOString()), { etag: prev.etag });
      spy.mockRestore();
      expect(result).toEqual({ ok: false, reason: 'storage_unavailable' });
      expect(await store.getEntryWithEtag('alice', FOO)).toEqual(prev);
    });

    it('SO test 3: an upload that times out but landed is acknowledged (read-back by stageId)', async () => {
      const store = makeStore(container, `_test-${++counter}`);
      const spy = spyUploads(async (self, real, args) => {
        if (!self.name.endsWith('.json')) return real(...args);
        await real(...args); // the write lands...
        throw Object.assign(new Error('simulated client timeout'), { name: 'AbortError' }); // ...but the caller never hears back
      });
      const mine = entryAt('landed', new Date().toISOString());
      const result = await store.stage('alice', FOO, mine, { absent: true });
      spy.mockRestore();
      expect(result).toMatchObject({ ok: true, etag: expect.any(String) });
      expect(await store.getEntry('alice', FOO)).toEqual(mine);
    });

    it('an ambiguous failure that did not land is not acknowledged, and the previous value stays', async () => {
      const store = makeStore(container, `_test-${++counter}`);
      await store.stage('alice', FOO, entryAt('v1', new Date().toISOString()), { absent: true });
      const prev = (await store.getEntryWithEtag('alice', FOO))!;
      const spy = spyUploads((self, real, args) => self.name.endsWith('.json')
        ? Promise.reject(new RestError('simulated 503', { statusCode: 503 }))
        : real(...args));
      const result = await store.stage('alice', FOO, entryAt('v2', new Date().toISOString()), { etag: prev.etag });
      spy.mockRestore();
      expect(result).toEqual({ ok: false, reason: 'storage_unavailable' });
      expect(await store.getEntryWithEtag('alice', FOO)).toEqual(prev);
    });

    it('a 2xx upload with no ETag is acknowledged without a read-back (t/503#15)', async () => {
      const store = makeStore(container, `_test-${++counter}`);
      const spy = spyUploads(async (self, real, args) => {
        const resp = await real(...args);
        return self.name.endsWith('.json') ? { ...(resp as object), etag: undefined } : resp;
      });
      const result = await store.stage('alice', FOO, entryAt('x', new Date().toISOString()), { absent: true });
      spy.mockRestore();
      expect(result).toMatchObject({ ok: true, etag: null, genBumped: true });
    });

    it('etag: a stale ETag returns precondition_failed with the current entry, and writes nothing', async () => {
      const store = makeStore(container, `_test-${++counter}`);
      await store.stage('alice', FOO, entryAt('v1', new Date().toISOString()), { absent: true });
      const stale = (await store.getEntryWithEtag('alice', FOO))!;
      await store.stage('alice', FOO, entryAt('v2', new Date().toISOString()), { etag: stale.etag });
      const current = (await store.getEntryWithEtag('alice', FOO))!;

      const result = await store.stage('alice', FOO, entryAt('v3', new Date().toISOString()), { etag: stale.etag });
      expect(result).toEqual({ ok: false, reason: 'precondition_failed', current });
      expect(await store.getEntryWithEtag('alice', FOO)).toEqual(current);
    });

    it('absent: an existing entry returns precondition_failed, and writes nothing', async () => {
      const store = makeStore(container, `_test-${++counter}`);
      await store.stage('alice', FOO, entryAt('v1', new Date().toISOString()), { absent: true });
      const result = await store.stage('alice', FOO, entryAt('v2', new Date().toISOString()), { absent: true });
      expect(result).toMatchObject({ ok: false, reason: 'precondition_failed', current: { entry: { content: 'v1' } } });
    });

    // TL p/50#161: two tabs (here, two replicas) save one path from the same base. Exactly one is acknowledged.
    it.each([
      ['both checked an existing entry (same etag)', true],
      ['both saw no entry (absent)', false],
    ])('two-tab race, %s: exactly one save is acknowledged, the other gets precondition_failed', async (_name, seeded) => {
      const prefix = `_test-${++counter}`;
      const tabA = makeStore(container, prefix);
      const tabB = makeStore(container, prefix);
      let expectBoth: { etag: string } | { absent: true } = { absent: true };
      if (seeded) {
        await tabA.stage('alice', FOO, entryAt('base', new Date().toISOString()), { absent: true });
        expectBoth = { etag: (await tabA.getEntryWithEtag('alice', FOO))!.etag };
      }
      const a = entryAt('from tab A', new Date().toISOString());
      const b = entryAt('from tab B', new Date().toISOString());
      const [ra, rb] = await Promise.all([tabA.stage('alice', FOO, a, expectBoth), tabB.stage('alice', FOO, b, expectBoth)]);

      const oks = [ra, rb].filter(r => r.ok);
      expect(oks).toHaveLength(1);
      const loser = ra.ok ? rb : ra;
      expect(loser).toMatchObject({ ok: false, reason: 'precondition_failed' });
      expect((await tabA.getEntry('alice', FOO))?.content).toBe(ra.ok ? 'from tab A' : 'from tab B');
    });

    it('latestWins: an entry staged later is never overwritten (newer_exists)', async () => {
      const store = makeStore(container, `_test-${++counter}`);
      await store.stage('alice', FOO, entryAt('newer', '2026-11-24T12:00:01.000Z'), LW);
      const result = await store.stage('alice', FOO, entryAt('older', '2026-11-24T12:00:00.000Z'), LW);
      expect(result).toMatchObject({ ok: false, reason: 'newer_exists', current: { entry: { content: 'newer' } } });
      expect((await store.getEntry('alice', FOO))?.content).toBe('newer');
    });

    it('latestWins: a 412 re-reads; an older interleaved write is overwritten with OUR stagedAt and stageId unchanged', async () => {
      const prefix = `_test-${++counter}`;
      const store = makeStore(container, prefix);
      const other = makeStore(container, prefix);
      await store.stage('alice', FOO, entryAt('v0', '2026-11-24T11:00:00.000Z'), LW);
      let interleaved = false;
      const spy = spyUploads(async (self, real, args) => {
        if (self.name.endsWith('.json') && !interleaved) {
          interleaved = true; // an older save lands between our read and our upload, so our upload gets a 412
          await other.stage('alice', FOO, entryAt('older interleaved', '2026-11-24T11:30:00.000Z'), LW);
        }
        return real(...args);
      });
      const mine = entryAt('mine', '2026-11-24T12:00:00.000Z');
      const result = await store.stage('alice', FOO, mine, LW);
      spy.mockRestore();
      expect(result.ok).toBe(true);
      expect(await store.getEntry('alice', FOO)).toEqual(mine);
    });

    it('SO condition 2: every entry upload carries ifMatch or ifNoneMatch, whatever the expect', async () => {
      const store = makeStore(container, `_test-${++counter}`);
      const seen: Array<Record<string, unknown> | undefined> = [];
      const spy = spyUploads((self, real, args) => {
        if (self.name.endsWith('.json')) seen.push((args[2] as { conditions?: Record<string, unknown> } | undefined)?.conditions);
        return real(...args);
      });
      await store.stage('alice', FOO, entryAt('a', new Date().toISOString()), { absent: true });
      const got = (await store.getEntryWithEtag('alice', FOO))!;
      await store.stage('alice', FOO, entryAt('b', new Date().toISOString()), { etag: got.etag });
      await store.stage('alice', FOO, entryAt('c', new Date().toISOString()), LW);
      await store.stage('alice', 'taxonomy/new.json', entryAt('d', new Date().toISOString()), LW);
      await store.rebaseEntry('alice', FOO, { ifMatch: (await store.getEntryWithEtag('alice', FOO))!.etag, baseSha: 'base1' });
      spy.mockRestore();
      expect(seen.length).toBe(5);
      for (const c of seen) expect(Boolean(c && (c.ifMatch || c.ifNoneMatch))).toBe(true);
    });

    it('rebaseEntry sets baseSha only (content, stagedAt and stageId kept); a stale ifMatch is "changed"', async () => {
      const store = makeStore(container, `_test-${++counter}`);
      const mine = entryAt('content', new Date().toISOString(), null);
      await store.stage('alice', FOO, mine, { absent: true });
      const got = (await store.getEntryWithEtag('alice', FOO))!;
      expect(await store.rebaseEntry('alice', FOO, { ifMatch: got.etag, baseSha: 'committed-blob' })).toBe('rebased');
      expect(await store.getEntry('alice', FOO)).toEqual({ ...mine, baseSha: 'committed-blob' });
      expect(await store.rebaseEntry('alice', FOO, { ifMatch: got.etag, baseSha: 'other' })).toBe('changed');
      expect(await store.rebaseEntry('alice', 'taxonomy/none.json', { ifMatch: got.etag, baseSha: 'x' })).toBe('changed');
    });

    // Quality on #5459: the SDK retries an upload whose response was lost; if the first attempt landed, the
    // retry's condition fails against our own write. That must be acknowledged, not reported as a conflict.
    function landThenReject(status: 412 | 409) {
      return spyUploads(async (self, real, args) => {
        if (!self.name.endsWith('.json')) return real(...args);
        await real(...args); // the first attempt lands...
        throw new RestError(status === 412 ? 'ConditionNotMet' : 'BlobAlreadyExists', // ...the retry fails its condition
          { statusCode: status, code: status === 412 ? 'ConditionNotMet' : 'BlobAlreadyExists' });
      });
    }

    it.each([
      ['etag (412)', 412, 'etag'],
      ['absent (409 BlobAlreadyExists)', 409, 'absent'],
      ['latestWins over an entry (412)', 412, 'latestWins'],
      ['latestWins with no entry (409 BlobAlreadyExists)', 409, 'latestWinsFresh'],
    ] as const)('an upload that landed but then failed its condition is acknowledged: %s', async (_name, status, kind) => {
      const store = makeStore(container, `_test-${++counter}`);
      let expectArg: { etag: string } | { absent: true } | { latestWins: true } = kind === 'absent' ? { absent: true } : LW;
      if (kind === 'etag' || kind === 'latestWins') {
        await store.stage('alice', FOO, entryAt('before', '2026-11-24T10:00:00.000Z'), { absent: true });
        if (kind === 'etag') expectArg = { etag: (await store.getEntryWithEtag('alice', FOO))!.etag };
      }
      const mine = entryAt('mine', '2026-11-24T12:00:00.000Z');
      const spy = landThenReject(status);
      const result = await store.stage('alice', FOO, mine, expectArg);
      spy.mockRestore();
      expect(result).toMatchObject({ ok: true, etag: expect.any(String) });
      expect(await store.getEntry('alice', FOO)).toEqual(mine);
    });

    // SO on #5459: the same entry staged twice with the now-stale condition (what an SDK retry does).
    it('staging the same entry twice with the stale condition acknowledges both (absent, then etag)', async () => {
      const store = makeStore(container, `_test-${++counter}`);
      const first = entryAt('mine', new Date().toISOString());
      expect((await store.stage('alice', FOO, first, { absent: true })).ok).toBe(true);
      expect(await store.stage('alice', FOO, first, { absent: true })).toMatchObject({ ok: true, etag: expect.any(String) });

      const staleEtag = (await store.getEntryWithEtag('alice', FOO))!.etag;
      const second = entryAt('mine again', new Date().toISOString());
      expect((await store.stage('alice', FOO, second, { etag: staleEtag })).ok).toBe(true);
      expect(await store.stage('alice', FOO, second, { etag: staleEtag })).toMatchObject({ ok: true });
      expect(await store.getEntry('alice', FOO)).toEqual(second);
    });

    it('a failed condition against someone else\'s write is still precondition_failed (control)', async () => {
      const store = makeStore(container, `_test-${++counter}`);
      await store.stage('alice', FOO, entryAt('theirs', new Date().toISOString()), { absent: true });
      const result = await store.stage('alice', FOO, entryAt('mine', new Date().toISOString()), { absent: true });
      expect(result).toMatchObject({ ok: false, reason: 'precondition_failed', current: { entry: { content: 'theirs' } } });
    });

    it('rebaseEntry: a rebase that landed but then got a 412 on retry is "rebased", not "changed"', async () => {
      const store = makeStore(container, `_test-${++counter}`);
      await store.stage('alice', FOO, entryAt('content', new Date().toISOString(), null), { absent: true });
      const got = (await store.getEntryWithEtag('alice', FOO))!;
      const spy = landThenReject(412);
      const result = await store.rebaseEntry('alice', FOO, { ifMatch: got.etag, baseSha: 'committed-blob' });
      spy.mockRestore();
      expect(result).toBe('rebased');
      expect((await store.getEntry('alice', FOO))?.baseSha).toBe('committed-blob');
    });

    it('baseSha null (absent when staged) round-trips, distinct from "unknown"', async () => {
      const store = makeStore(container, `_test-${++counter}`);
      await store.stage('alice', FOO, entryAt('x', new Date().toISOString(), null), { absent: true });
      expect((await store.getEntry('alice', FOO))?.baseSha).toBeNull();
    });
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
    const result = await store.stage('alice', 'taxonomy/foo.json', withId({ content: 'x', baseSha: 'unknown', stagedAt: new Date().toISOString() }), LW);
    expect(result).toEqual({ ok: false, reason: 'storage_unavailable' });
  }, 20000);
});
