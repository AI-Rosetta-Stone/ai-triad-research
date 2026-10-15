// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * BlobLease — cross-replica single-holder election via Azure Blob's native
 * lease API (t/4179, TL design t/4179#2).
 *
 * TL: "Use Azure Blob's native lease API (acquireLease/renewLease/
 * releaseLease, 15-60s) for holder election, instead of hand-rolled etag CAS
 * on the state blob. It's built for exactly this leader election." This is
 * the one shared implementation both t/4179 (GitHub poll single-holder) and
 * t/4177 (grounding-sweep guard, deferred per t/4177#11 — the sweep never
 * arms in prod today) are meant to consume, so a second lease never gets
 * hand-rolled elsewhere.
 *
 * The SAME blob this class leases can also carry published coordination
 * state (e.g. a poller's last-seen commit SHA) — the current holder writes
 * that state with `conditions: { leaseId: lease.getLeaseId() }`. That is the
 * fencing TL required: a holder that renewed too late, after another replica
 * already took the lease, gets a 412 (LeaseIdMismatchWithBlobOperation) on
 * its next write instead of silently publishing stale state under a lease it
 * no longer holds. `acquireOrRenew()` never resolves that race itself — it
 * only tracks whether THIS instance currently believes it holds the lease;
 * the fenced write is what catches a belief that turned out to be wrong.
 */

import { BlobServiceClient, type ContainerClient, type BlockBlobClient, RestError } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../../lib/debate/errors.js';

export interface BlobLeaseOptions {
  /** e.g. https://<account>.blob.core.windows.net — from AZURE_STORAGE_ACCOUNT_URL. */
  accountUrl: string;
  container: string;
  /** The blob this lease arbitrates. Created empty on first use if missing —
   *  only its existence matters for leasing; coordination state is written
   *  separately by the holder via a fenced upload to the same blob. */
  blobName: string;
  /** Azure Blob lease duration in seconds. Must be 15-60 (TL t/4179#2) or the
   *  service rejects it. */
  durationSeconds: number;
  /** Test seam: inject a pre-built client (e.g. an Azurite shared-key client). */
  serviceClient?: BlobServiceClient;
}

function isNotFound(err: unknown): boolean {
  return err instanceof RestError ? (err.statusCode === 404 || err.code === 'BlobNotFound') : false;
}

/** 409 on acquire = someone else already holds the lease — the expected
 *  "not me this round" outcome, not an infrastructure failure. */
function isLeaseConflict(err: unknown): boolean {
  return err instanceof RestError && err.statusCode === 409;
}

/** Build an ActionableError for a failed Blob SDK lease operation, same
 *  convention as azureBlobBackend.ts's wrapBlobError. Never includes
 *  credentials — auth is via the credential object, not the message. Pure
 *  (no recording) — ADR-003 requires the getGlobalRecorder() call to stay
 *  literally inline in each catch block, so callers record, then wrap. */
function wrapLeaseError(err: unknown, op: string, blobName: string): ActionableError {
  return new ActionableError({
    goal: `Blob lease ${op}`,
    problem: `Lease operation "${op}" failed for "${blobName}": ${(err as Error)?.message ?? String(err)}`,
    location: `BlobLease.${op}`,
    nextSteps: [
      'Verify the storage account is reachable and the managed identity has data-plane access',
      'Check Azure Blob service health and retry',
    ],
    innerError: err,
  });
}

export class BlobLease {
  private readonly blobClient: BlockBlobClient;
  private readonly blobName: string;
  private readonly durationSeconds: number;
  private leaseId: string | undefined;

  constructor(opts: BlobLeaseOptions) {
    const service = opts.serviceClient
      ?? new BlobServiceClient(opts.accountUrl, new DefaultAzureCredential());
    const container: ContainerClient = service.getContainerClient(opts.container);
    this.blobClient = container.getBlockBlobClient(opts.blobName);
    this.blobName = opts.blobName;
    this.durationSeconds = opts.durationSeconds;
  }

  /** The lease id to pass as `conditions.leaseId` on a write to the same
   *  blob, fencing that write to this holder's current lease. `undefined` if
   *  this instance does not currently believe it holds the lease. */
  getLeaseId(): string | undefined {
    return this.leaseId;
  }

  isHolder(): boolean {
    return this.leaseId !== undefined;
  }

  /**
   * Attempt to acquire the lease (if free) or renew it (if this instance
   * already holds it). Returns true iff this instance holds the lease after
   * the call.
   *
   * Never throws for "someone else holds it" or "our renewal was rejected
   * because the lease already moved on" — both resolve to a clean `false`
   * (or a fallthrough to a fresh acquire attempt), since losing an election
   * is routine, not a failure. Only a genuine infrastructure failure
   * (network, auth, a missing container) throws; the caller should treat
   * that as "coordination unavailable — fall back to acting directly, with a
   * WARN" (TL t/4179#2 §2 point 2), not as "we are not the holder."
   */
  async acquireOrRenew(): Promise<boolean> {
    await this.ensureBlobExists();

    if (this.leaseId) {
      const renewClient = this.blobClient.getBlobLeaseClient(this.leaseId);
      try {
        await renewClient.renewLease();
        return true;
      } catch {
        /* telemetry — silent by design: renewal loss is the routine "another
         * replica took over" outcome, not an error. Clear and try a fresh
         * acquire below, same as if we'd never held it. */
        this.leaseId = undefined;
      }
    }

    const acquireClient = this.blobClient.getBlobLeaseClient();
    try {
      const result = await acquireClient.acquireLease(this.durationSeconds);
      this.leaseId = result.leaseId;
      return true;
    } catch (err) {
      if (isLeaseConflict(err)) return false;
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'blob-lease', level: 'error',
        message: `acquireLease failed: ${this.blobName}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw wrapLeaseError(err, 'acquireLease', this.blobName);
    }
  }

  /** Best-effort release, so a graceful shutdown doesn't hold the lease for
   *  its full duration while this replica is gone. Never throws — a failed
   *  release just means the lease expires naturally at `durationSeconds`. */
  async release(): Promise<void> {
    if (!this.leaseId) return;
    const leaseClient = this.blobClient.getBlobLeaseClient(this.leaseId);
    try {
      await leaseClient.releaseLease();
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'blob-lease', level: 'warn',
        message: `releaseLease failed — lease will expire naturally: ${this.blobName}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    } finally {
      this.leaseId = undefined;
    }
  }

  private async ensureBlobExists(): Promise<void> {
    try {
      await this.blobClient.getProperties();
    } catch (err) {
      if (!isNotFound(err)) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'blob-lease', level: 'error',
          message: `getProperties failed: ${this.blobName}`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        throw wrapLeaseError(err, 'getProperties', this.blobName);
      }
      try {
        // Empty seed blob — only its existence matters for leasing.
        await this.blobClient.upload('', 0, { conditions: { ifNoneMatch: '*' } });
      } catch (createErr) {
        // Lost the create race to another replica — fine, the blob exists either way.
        if (!(createErr instanceof RestError && createErr.statusCode === 409)) {
          getGlobalRecorder()?.record({
            type: 'system.error', component: 'blob-lease', level: 'error',
            message: `ensureBlobExists (seed upload) failed: ${this.blobName}`,
            error: { name: (createErr as Error).name ?? 'Error', message: String(createErr), stack: (createErr as Error).stack },
          });
          throw wrapLeaseError(createErr, 'ensureBlobExists (seed upload)', this.blobName);
        }
      }
    }
  }
}
