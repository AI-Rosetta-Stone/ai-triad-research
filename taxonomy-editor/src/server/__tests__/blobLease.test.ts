// @vitest-environment node

/**
 * t/4179 — BlobLease integration tests against Azurite (the Azure Storage
 * emulator), same pattern as azureBlobBackend.test.ts but on a different port
 * (10001) so the two Azurite instances never collide when test files run
 * concurrently.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BlobServiceClient, RestError } from '@azure/storage-blob';
import { BlobLease } from '../storage/blobLease.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const AZURITE_MAIN = path.resolve(here, '../../../node_modules/azurite/dist/src/blob/main.js');
const PORT = 10001;
const CONN = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:${PORT}/devstoreaccount1;`;
const CONTAINER = 'poll-coordination';

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

function makeLease(blobName: string, durationSeconds = 15): BlobLease {
  return new BlobLease({
    accountUrl: `http://127.0.0.1:${PORT}/devstoreaccount1`,
    container: CONTAINER,
    blobName,
    durationSeconds,
    serviceClient: service,
  });
}

describe('BlobLease (Azurite)', () => {
  beforeAll(async () => {
    azuriteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-lease-test-'));
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

  // A fresh blob name per test — one shared blob across tests would let an
  // earlier test's still-live lease leak into a later test's "acquire when
  // free" assumption.
  let blobName: string;
  beforeEach(() => { blobName = `lease-${++counter}.lock`; });

  it('acquires a free lease: isHolder() true, a leaseId is set', async () => {
    const lease = makeLease(blobName);
    expect(await lease.acquireOrRenew()).toBe(true);
    expect(lease.isHolder()).toBe(true);
    expect(lease.getLeaseId()).toBeTruthy();
    await lease.release();
  });

  it('a second instance cannot acquire a lease already held by another', async () => {
    const holder = makeLease(blobName);
    const contender = makeLease(blobName);
    expect(await holder.acquireOrRenew()).toBe(true);

    expect(await contender.acquireOrRenew()).toBe(false);
    expect(contender.isHolder()).toBe(false);

    await holder.release();
  });

  it('renews an already-held lease (same instance stays the holder)', async () => {
    const lease = makeLease(blobName);
    expect(await lease.acquireOrRenew()).toBe(true);
    const firstLeaseId = lease.getLeaseId();

    expect(await lease.acquireOrRenew()).toBe(true); // renew path
    expect(lease.getLeaseId()).toBe(firstLeaseId); // Azure keeps the same lease id across a renewal

    await lease.release();
  });

  it('release frees the lease for another instance to acquire', async () => {
    const holder = makeLease(blobName);
    const contender = makeLease(blobName);
    expect(await holder.acquireOrRenew()).toBe(true);
    expect(await contender.acquireOrRenew()).toBe(false);

    await holder.release();
    expect(holder.isHolder()).toBe(false);

    expect(await contender.acquireOrRenew()).toBe(true);
    await contender.release();
  });

  it('release is a safe no-op when this instance never held the lease', async () => {
    const lease = makeLease(blobName);
    await expect(lease.release()).resolves.toBeUndefined();
    expect(lease.isHolder()).toBe(false);
  });

  // The real "holder dies" path: a genuinely expired lease (never released),
  // not a forced release — proves acquireOrRenew's fresh-acquire fallthrough
  // works against natural expiry, not just an explicit release(). 15s is
  // Azure Blob's minimum lease duration, so this test is slow by necessity.
  it('after the lease duration elapses with no renewal, another instance takes over (holder-dies simulation)', async () => {
    const holder = makeLease(blobName, 15);
    const successor = makeLease(blobName, 15);
    expect(await holder.acquireOrRenew()).toBe(true);
    expect(await successor.acquireOrRenew()).toBe(false);

    await new Promise(r => setTimeout(r, 16_000)); // past the 15s duration, no renewal

    expect(await successor.acquireOrRenew()).toBe(true);
    expect(successor.isHolder()).toBe(true);

    await successor.release();
  }, 25_000);

  it('fencing: a write using the current holder\'s leaseId succeeds; a stale leaseId after takeover is rejected (412)', async () => {
    const holder = makeLease(blobName);
    expect(await holder.acquireOrRenew()).toBe(true);
    const staleLeaseId = holder.getLeaseId()!;

    const blockBlobClient = service.getContainerClient(CONTAINER).getBlockBlobClient(blobName);
    const payload = JSON.stringify({ lastCommitSha: 'abc123' });
    // The current holder's write, fenced to its own lease — succeeds.
    await expect(blockBlobClient.upload(payload, Buffer.byteLength(payload), {
      conditions: { leaseId: staleLeaseId },
    })).resolves.toBeDefined();

    // Simulate a takeover: release, then another instance acquires (gets a
    // fresh leaseId). The original holder's now-stale leaseId must no longer
    // fence a write — that's the whole point of fencing.
    await holder.release();
    const successor = makeLease(blobName);
    expect(await successor.acquireOrRenew()).toBe(true);
    expect(successor.getLeaseId()).not.toBe(staleLeaseId);

    const stalePayload = JSON.stringify({ lastCommitSha: 'this-should-not-land' });
    await expect(blockBlobClient.upload(stalePayload, Buffer.byteLength(stalePayload), {
      conditions: { leaseId: staleLeaseId },
    })).rejects.toThrow();

    try {
      await blockBlobClient.upload(stalePayload, Buffer.byteLength(stalePayload), { conditions: { leaseId: staleLeaseId } });
    } catch (err) {
      expect(err).toBeInstanceOf(RestError);
      expect((err as RestError).statusCode).toBe(412);
    }

    await successor.release();
  });

  it('acquireOrRenew creates the coordination blob on first use (no pre-existing blob needed)', async () => {
    const lease = makeLease(blobName);
    expect(await service.getContainerClient(CONTAINER).getBlockBlobClient(blobName).exists()).toBe(false);
    expect(await lease.acquireOrRenew()).toBe(true);
    expect(await service.getContainerClient(CONTAINER).getBlockBlobClient(blobName).exists()).toBe(true);
    await lease.release();
  });
});
