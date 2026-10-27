// @vitest-environment node

/**
 * t/4491 AC2-5 — BlobFreePoolBudget's key-based debate admission
 * (reserveForKey/drawDown/openCountForPrefix), against Azurite. Own port
 * (10005) distinct from freePoolBudget.test.ts's 10003, so the two Azurite
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
const PORT = 10005;
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

function makeBudget(
  prefix: string,
  opts: Partial<{ callsCap: number; tokensCap: number | null; reservationTtlMs: number; now: () => Date }> = {},
): BlobFreePoolBudget {
  return new BlobFreePoolBudget({
    accountUrl: ACCOUNT_URL,
    container: CONTAINER,
    blobPrefix: prefix,
    callsCap: opts.callsCap ?? 100,
    tokensCap: opts.tokensCap,
    reservationTtlMs: opts.reservationTtlMs,
    serviceClient: service,
    now: opts.now,
  });
}

/** t/4549: a controllable clock for TTL tests — no wall-clock `setTimeout`
 *  waits. `advance()` moves the clock forward by exactly the given amount;
 *  every subsequent `now()` call (sweep comparisons, `expiresAt` renewal)
 *  sees the new time deterministically, so expiry assertions don't depend
 *  on real elapsed time or CI scheduling jitter (the t/4502 flake class). */
function makeFakeClock(start: Date = new Date('2026-01-01T00:00:00.000Z')) {
  let current = start;
  return {
    now: (): Date => current,
    advance: (ms: number): void => { current = new Date(current.getTime() + ms); },
  };
}

describe('BlobFreePoolBudget.reserveForKey/drawDown/openCountForPrefix (Azurite, t/4491 AC2-5)', () => {
  beforeAll(async () => {
    azuriteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-free-pool-key-test-'));
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

  let prefix: string;
  beforeEach(() => { prefix = `_test-free-pool-key-${++counter}`; });

  it('reserveForKey is idempotent while a reservation is live: second call returns the same id, existing:true', async () => {
    const budget = makeBudget(prefix);
    const r1 = await budget.reserveForKey({ key: 'debate:u1:d1', calls: 10, tokens: 500 });
    expect(r1).toMatchObject({ ok: true, existing: false });
    if (!r1.ok) return;

    const r2 = await budget.reserveForKey({ key: 'debate:u1:d1', calls: 10, tokens: 500 });
    expect(r2).toMatchObject({ ok: true, existing: true, reservationId: r1.reservationId });
  });

  it('replica-safety: two concurrent reserveForKey calls for the same key agree on exactly one reservation', async () => {
    const replicaA = makeBudget(prefix);
    const replicaB = makeBudget(prefix);
    const [a, b] = await Promise.all([
      replicaA.reserveForKey({ key: 'debate:u2:d1', calls: 5, tokens: 100 }),
      replicaB.reserveForKey({ key: 'debate:u2:d1', calls: 5, tokens: 100 }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.reservationId).toBe(b.reservationId);
    // Exactly one of the two actually created it; the other found it existing.
    expect([a.existing, b.existing].sort()).toEqual([false, true]);
  });

  it('drawDown accumulates additively across repeated calls and renews expiresAt each time', async () => {
    const budget = makeBudget(prefix, { reservationTtlMs: 60000 });
    const r = await budget.reserveForKey({ key: 'debate:u3:d1', calls: 20, tokens: 1000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const first = await budget.drawDown(r.reservationId, { calls: 2, tokens: 80 });
    expect(first).toMatchObject({ drawnCalls: 2, drawnTokens: 80, estimateCalls: 20, estimateTokens: 1000 });

    const second = await budget.drawDown(r.reservationId, { calls: 3, tokens: 90 });
    expect(second).toMatchObject({ drawnCalls: 5, drawnTokens: 170, estimateCalls: 20, estimateTokens: 1000 }); // additive, not replaced
  });

  it('drawDown on an unknown/expired id returns null, never throws', async () => {
    const budget = makeBudget(prefix);
    const fakeId = `${new Date().toISOString().slice(0, 10)}:does-not-exist`;
    await expect(budget.drawDown(fakeId, { calls: 1, tokens: 1 })).resolves.toBeNull();
  });

  it('drawDown past the original estimate succeeds (no refusal), and the larger drawn total counts against the cap', async () => {
    const callsCap = 10;
    const budget = makeBudget(prefix, { callsCap });
    const r = await budget.reserveForKey({ key: 'debate:u4:d1', calls: 3, tokens: 0 }); // held estimate: 3
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const drawn = await budget.drawDown(r.reservationId, { calls: 8, tokens: 0 }); // overdraft past the estimate of 3
    expect(drawn).toMatchObject({ drawnCalls: 8, estimateCalls: 3 }); // succeeded, not refused

    // A different key's reservation must see the real 8, not the stale estimate of 3 —
    // 8 + 3 > 10, so this must refuse.
    const other = await budget.reserveForKey({ key: 'debate:u5:d1', calls: 3, tokens: 0 });
    expect(other).toMatchObject({ ok: false, reason: 'daily_cap' });
  });

  // t/4549: fake clock, not wall-clock sleeps — deterministic by
  // construction, not by generous margins.
  it('openCountForPrefix counts only live entries under the prefix; committed and swept-expired ones are excluded', async () => {
    const clock = makeFakeClock();
    const budget = makeBudget(prefix, { reservationTtlMs: 400, now: clock.now });
    await budget.reserveForKey({ key: 'debate:u6:d1', calls: 1, tokens: 0 });
    const r2 = await budget.reserveForKey({ key: 'debate:u6:d2', calls: 1, tokens: 0 });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const r3 = await budget.reserveForKey({ key: 'debate:u6:d3', calls: 1, tokens: 0 }); // will expire, untouched
    expect(r3.ok).toBe(true);

    // An idempotent re-hit on an existing key must not double-count.
    await budget.reserveForKey({ key: 'debate:u6:d1', calls: 1, tokens: 0 });

    // d1/d3's original 400ms TTL is still running; renew d2 well after
    // d1/d3 were created, so d2's fresh 400ms window (from this later point)
    // outlives theirs.
    clock.advance(250);
    await budget.drawDown(r2.reservationId, { calls: 1, tokens: 0 }); // renews TTL from this later point in time

    clock.advance(200); // past d1/d3's original TTL (250+200=450 > 400), well before d2's renewed one (250+400=650)

    const count = await budget.openCountForPrefix('debate:u6:');
    expect(count).toBe(1); // only d2 (renewed via drawDown) is still live; d1 and d3 expired
  });

  it("maxOpenForPrefix is enforced atomically: two different new keys racing the same prefix limit never both get admitted past it", async () => {
    const budget = makeBudget(prefix);
    await budget.reserveForKey({ key: 'debate:u7:d1', calls: 1, tokens: 0 }); // 1 already open

    const replicaA = makeBudget(prefix);
    const replicaB = makeBudget(prefix);
    const [a, b] = await Promise.all([
      replicaA.reserveForKey({ key: 'debate:u7:d2', calls: 1, tokens: 0, maxOpenForPrefix: { prefix: 'debate:u7:', max: 2 } }),
      replicaB.reserveForKey({ key: 'debate:u7:d3', calls: 1, tokens: 0, maxOpenForPrefix: { prefix: 'debate:u7:', max: 2 } }),
    ]);
    const admitted = [a, b].filter(r => r.ok).length;
    const refused = [a, b].filter(r => !r.ok);
    expect(admitted).toBe(1); // d1 + exactly one of d2/d3 — never both
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ ok: false, reason: 'debate_limit' });
  });

  // t/4549 (origin of the flake: a real 50ms TTL against a 200ms wall-clock
  // sleep, the t/4502 timing-margin class — root cause was the test, not
  // the implementation). Fixed with a fake clock: deterministic by
  // construction, no elapsed real time at all.
  it('TTL expiry with a partial draw: headroom reflects only the drawn amount (the unused remainder is released, the draw is kept)', async () => {
    const clock = makeFakeClock();
    const budget = makeBudget(prefix, { callsCap: 50, reservationTtlMs: 50, now: clock.now });
    const r = await budget.reserveForKey({ key: 'debate:u8:d1', calls: 20, tokens: 0 }); // held estimate: 20
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await budget.drawDown(r.reservationId, { calls: 4, tokens: 0 }); // only 4 actually drawn — renews TTL to +50ms from now

    clock.advance(51); // past the renewed TTL

    const h = await budget.headroom(); // triggers the sweep (via download+sweepExpired)
    expect(h.callsUsed).toBe(4); // only the drawn amount survives — the unused 16 is released
  });

  it('TTL expiry with zero draw: the reservation is deleted entirely (unchanged legacy behavior)', async () => {
    const clock = makeFakeClock();
    const budget = makeBudget(prefix, { callsCap: 50, reservationTtlMs: 50, now: clock.now });
    const r = await budget.reserveForKey({ key: 'debate:u9:d1', calls: 20, tokens: 0 }); // held estimate: 20, never drawn
    expect(r.ok).toBe(true);

    clock.advance(51);

    const h = await budget.headroom();
    expect(h.callsUsed).toBe(0); // nothing drawn, nothing survives — full release, not a partial auto-commit

    const count = await budget.openCountForPrefix('debate:u9:');
    expect(count).toBe(0);
  });
});
