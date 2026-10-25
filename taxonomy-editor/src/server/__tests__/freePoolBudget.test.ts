// @vitest-environment node

/**
 * t/4484 (AC2-6) — BlobFreePoolBudget integration tests against Azurite (the
 * Azure Storage emulator), same pattern as blobLease.test.ts and
 * azureBlobBackend.test.ts, on a distinct port (10003) so the Azurite
 * instances never collide when test files run concurrently.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BlobServiceClient } from '@azure/storage-blob';
import { BlobFreePoolBudget } from '../storage/freePoolBudget.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const AZURITE_MAIN = path.resolve(here, '../../../node_modules/azurite/dist/src/blob/main.js');
const PORT = 10003;
const CONN = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:${PORT}/devstoreaccount1;`;
const CONTAINER = 'user-content';
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

function makeBudget(prefix: string, opts: Partial<{ callsCap: number; tokensCap: number | null; reservationTtlMs: number }> = {}): BlobFreePoolBudget {
  return new BlobFreePoolBudget({
    accountUrl: ACCOUNT_URL,
    container: CONTAINER,
    blobPrefix: prefix,
    callsCap: opts.callsCap ?? 10,
    tokensCap: opts.tokensCap,
    reservationTtlMs: opts.reservationTtlMs,
    serviceClient: service,
  });
}

describe('BlobFreePoolBudget (Azurite)', () => {
  beforeAll(async () => {
    azuriteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-free-pool-test-'));
    proc = spawn(
      process.execPath,
      [AZURITE_MAIN, '--silent', '--skipApiVersionCheck', '--location', azuriteDir, '--blobHost', '127.0.0.1', '--blobPort', String(PORT)],
      { stdio: 'ignore' },
    );
    service = BlobServiceClient.fromConnectionString(CONN);
    await waitForAzurite(service);
    await service.getContainerClient(CONTAINER).createIfNotExists();
  }, 30000);

  afterAll(async () => {
    if (proc) proc.kill();
    try { fs.rmSync(azuriteDir, { recursive: true, force: true }); } catch { /* emulator may still hold a handle */ }
  });

  // A fresh blob prefix per test — one shared blob across tests would let an
  // earlier test's usage leak into a later test's cap assumptions.
  let prefix: string;
  beforeEach(() => { prefix = `_test-free-pool-budget-${++counter}`; });

  it('reserve/commit/release round-trip: headroom reflects committed usage', async () => {
    const budget = makeBudget(prefix, { callsCap: 10, tokensCap: 1000 });
    const r1 = await budget.reserve({ calls: 2, tokens: 100, key: 'debate-1' });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    await budget.commit(r1.reservationId, { calls: 3, tokens: 150 }); // actual exceeded the estimate
    const h1 = await budget.headroom();
    expect(h1.callsUsed).toBe(3);
    expect(h1.tokensUsed).toBe(150);

    const r2 = await budget.reserve({ calls: 1, tokens: 50, key: 'debate-2' });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    await budget.release(r2.reservationId); // unused — returns its budget
    const h2 = await budget.headroom();
    expect(h2.callsUsed).toBe(3); // unchanged — the released reservation never counted after release
  });

  it('refuses at the cap: reason daily_cap, with resetsAt', async () => {
    const budget = makeBudget(prefix, { callsCap: 2 });
    const r1 = await budget.reserve({ calls: 2, tokens: 0, key: 'a' });
    expect(r1.ok).toBe(true);

    const r2 = await budget.reserve({ calls: 1, tokens: 0, key: 'b' });
    expect(r2).toMatchObject({ ok: false, reason: 'daily_cap' });
    if (r2.ok || r2.reason !== 'daily_cap') throw new Error('unreachable');
    expect(r2.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  });

  it('AC2: two concurrent reserve() calls against a nearly full budget never jointly exceed the cap', async () => {
    const callsCap = 5;
    const seeded = makeBudget(prefix, { callsCap });
    const seed = await seeded.reserve({ calls: 4, tokens: 0, key: 'seed' });
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;
    await seeded.commit(seed.reservationId, { calls: 4, tokens: 0 }); // 4 of 5 used, 1 left

    // Two independent "replicas" racing for the last unit of budget.
    const replicaA = makeBudget(prefix, { callsCap });
    const replicaB = makeBudget(prefix, { callsCap });
    const [a, b] = await Promise.all([
      replicaA.reserve({ calls: 1, tokens: 0, key: 'race-a' }),
      replicaB.reserve({ calls: 1, tokens: 0, key: 'race-b' }),
    ]);

    const okCount = [a, b].filter((r) => r.ok).length;
    expect(okCount).toBe(1); // exactly one of the two gets the last unit
    const refused = [a, b].find((r) => !r.ok);
    expect(refused).toMatchObject({ ok: false, reason: 'daily_cap' });

    const final = await seeded.headroom();
    expect(final.callsUsed).toBeLessThanOrEqual(callsCap); // never jointly exceeds the cap
  });

  it('AC3: budget persists across a process restart (a fresh instance sees prior usage)', async () => {
    const first = makeBudget(prefix, { callsCap: 10 });
    const r = await first.reserve({ calls: 3, tokens: 0, key: 'before-restart' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await first.commit(r.reservationId, { calls: 3, tokens: 0 });

    // A brand-new instance — simulates a fresh process reading the same blob.
    const afterRestart = makeBudget(prefix, { callsCap: 10 });
    const h = await afterRestart.headroom();
    expect(h.callsUsed).toBe(3);
  });

  it('AC4: an unreleased reservation expires after its TTL and returns its budget', async () => {
    const budget = makeBudget(prefix, { callsCap: 5, reservationTtlMs: 50 });
    const r1 = await budget.reserve({ calls: 5, tokens: 0, key: 'short-lived' }); // fills the cap
    expect(r1.ok).toBe(true);

    const refused = await budget.reserve({ calls: 1, tokens: 0, key: 'blocked' });
    expect(refused.ok).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 150)); // past the 50ms TTL

    const afterExpiry = await budget.reserve({ calls: 1, tokens: 0, key: 'now-fits' });
    expect(afterExpiry.ok).toBe(true); // the expired reservation's budget returned
  });

  // CI flake (t/4499's PR surfaced it): a 150ms TTL left only ~50ms of slack
  // around each check, which real Azurite network round-trips under a loaded
  // CI runner can eat into — the reservation could cross its expiry between
  // the renew() call completing and the headroom() check running. Widened to
  // a 1s TTL with 300ms sleeps (700ms slack instead of ~50ms); the logical
  // assertion is unchanged, just far less timing-sensitive.
  it('renew() extends a reservation past its original TTL; returns false once gone', async () => {
    const budget = makeBudget(prefix, { callsCap: 5, reservationTtlMs: 1000 });
    const r = await budget.reserve({ calls: 2, tokens: 0, key: 'long-running' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await budget.renew(r.reservationId)).toBe(true); // renewed before the original TTL hit

    await new Promise((resolve) => setTimeout(resolve, 300)); // would have expired at 1000ms without the renew
    const h = await budget.headroom();
    expect(h.callsUsed).toBe(2); // still held — renew() kept it alive

    await budget.commit(r.reservationId, { calls: 2, tokens: 0 });
    expect(await budget.renew(r.reservationId)).toBe(false); // already committed — nothing left to renew
  });

  it('AC6: day rollover is isolated — a different day-prefixed blob never shares usage with today', async () => {
    // Pre-seed a "yesterday" blob directly, at the real prefix another day
    // would use, to prove this day's headroom is unaffected by it.
    const container = service.getContainerClient(CONTAINER);
    await container.getBlockBlobClient(`${prefix}/2020-01-01.json`).upload(
      JSON.stringify({ day: '2020-01-01', callsCap: 10, tokensCap: null, reservations: { 'x': { calls: 9, tokens: 0, key: 'old', createdAt: '2020-01-01T00:00:00.000Z', expiresAt: null, committed: true } } }),
      JSON.stringify({ day: '2020-01-01', callsCap: 10, tokensCap: null, reservations: { 'x': { calls: 9, tokens: 0, key: 'old', createdAt: '2020-01-01T00:00:00.000Z', expiresAt: null, committed: true } } }).length,
    );

    const budget = makeBudget(prefix, { callsCap: 10 });
    const h = await budget.headroom();
    expect(h.callsUsed).toBe(0); // today's blob is separate — unaffected by the other day's usage
    expect(h.day).not.toBe('2020-01-01');
  });

  it('commit/release never throw on an unknown reservation id (no-op)', async () => {
    const budget = makeBudget(prefix, { callsCap: 10 });
    const fakeId = `${new Date().toISOString().slice(0, 10)}:does-not-exist`;
    await expect(budget.commit(fakeId, { calls: 1, tokens: 1 })).resolves.toBeUndefined();
    await expect(budget.release(fakeId)).resolves.toBeUndefined();
    const h = await budget.headroom();
    expect(h.callsUsed).toBe(0);
  });

  // These two run last and kill the real Azurite process to simulate "storage
  // unreachable" — a closed port on this network stack doesn't fail fast
  // enough for a sane test timeout (OS-level connect timeout, not a quick
  // ECONNREFUSED), so an unresponsive/dead real endpoint is the reliable way
  // to exercise this path. No test after these needs Azurite; afterAll's
  // proc.kill() is a safe no-op on an already-dead process.
  it('AC5: fails closed when storage is unreachable — refuses, never throws, on reserve', async () => {
    proc.kill();
    const unreachable = makeBudget(prefix, { callsCap: 10 });
    const r = await unreachable.reserve({ calls: 1, tokens: 0, key: 'doomed' });
    expect(r).toEqual({ ok: false, reason: 'storage_unavailable' });
  }, 20000);

  it('AC5: headroom() throws (never a zeroed/sentinel result) when storage is unreachable', async () => {
    const unreachable = makeBudget(`${prefix}-headroom`, { callsCap: 10 });
    await expect(unreachable.headroom()).rejects.toThrow();
  }, 20000);
});
