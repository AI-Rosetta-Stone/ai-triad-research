// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * SharedOverlayStore — the shared, cross-replica form of a user's staged
 * overlay content (t/4311, "(c2)" design). Prerequisite for t/4181 raising
 * `maxReplicas` past 1: today's `sessionOverlays` map in
 * `githubAPIBackend.ts` is per-process, so a user's staged-but-uncommitted
 * writes split across replicas with no affinity available (Azure Container
 * Apps only supports session affinity in single-revision mode; prod runs
 * multiple-revision for blue-green, per e/332#4).
 *
 * **Scope of this module (TL p/538#223, after SO clearance e/332#8):** the
 * per-entry RMW primitives, the `_gen` generation mechanism, and the
 * environment-scoped container resolution (S3) — NOT wired into
 * `githubAPIBackend.ts`'s actual read/write/commit paths yet, and NOT the
 * `OVERLAY_SHARED_STATE_DRAINING` rollback logic. Both are separate
 * follow-up PRs, same t/4484→t/4491 AC-split precedent.
 *
 * **Shape:** one blob per staged path, `overlay-state/{userId}/{pathKey}.json`
 * — not one blob per user (t/4311#15 SO condition C3, t/4311#16 TL decision)
 * — so concurrent writes to different paths by the same user never contend
 * on one ETag. `pathKey` is `base64url(normalizedRepoPath)`: collision-free
 * and reversible for diagnostics, never a lossy slug (TL t/4311#16).
 *
 * **Read-your-writes via `_gen`, not a conditional prefix-list (t/4311#18
 * TL correction, t/4311#19/#21):** Azure Blob's List Blobs operation has no
 * conditional form and no listing ETag, so "a cheap conditional prefix-list"
 * isn't a real primitive. Each user has one `_gen` blob
 * (`overlay-state/{userId}/_gen`) that every stage/unstage overwrites with a
 * fresh nonce AFTER the entry write succeeds — the caller's write is not
 * acknowledged until the bump lands. A reader does a conditional GET on
 * `_gen` (a real 304 when unchanged) and only runs the real prefix-list when
 * the generation actually moved.
 *
 * **D1 (SO e/332#8): the `_gen` bump is an UNCONDITIONAL PUT, not a CAS.** A
 * conditional (`ifMatch`) bump would reintroduce exactly the same-user
 * cross-path contention per-entry blobs were built to remove — N concurrent
 * writes to different paths would all race one ETag. A reader only needs
 * "has `_gen`'s ETag changed", which an unconditional PUT of a fresh value
 * provides just as well: any successful PUT changes the blob's ETag, and the
 * entry-write-then-bump ordering still guarantees a reader who observes the
 * new ETag will find the entry (it was already written before the bump that
 * produced that ETag).
 *
 * **D2 (SO e/332#8, option (a)): a `_gen` bump failure deletes the
 * just-written entry before returning the error.** Without this, an entry
 * could exist in the store with no caller ever told it succeeded — and the
 * (later, separate-PR) commit path lists entries, not `_gen`, so it would
 * still commit an edit the user was told had failed. The invariant this
 * preserves: an entry that exists in the store is always one whose write was
 * successfully acknowledged.
 */

import { randomUUID } from 'crypto';
import { BlobServiceClient, type ContainerClient, type BlockBlobClient, RestError } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../../lib/debate/errors.js';

/** One staged path's content. `content: null` is a staged delete (mirrors
 *  the in-memory overlay's existing tombstone convention). `baseSha` is
 *  mandatory, never inferred safe (t/4311#9) — `'unknown'` is itself a
 *  recorded value, distinct from "no entry exists at all". */
export interface SharedOverlayEntry {
  content: string | null;
  baseSha: string | 'unknown';
  stagedAt: string;
}

export interface SharedOverlayStoreOptions {
  /** e.g. https://<account>.blob.core.windows.net — from AZURE_STORAGE_ACCOUNT_URL. */
  accountUrl: string;
  /** REQUIRED, no default (SO e/332#10 E2) — a silent default of `'user-content'`
   *  (prod's container) would mean a staging caller that forgets to pass
   *  this writes straight into prod, exactly the t/4264 class of bug S3
   *  exists to prevent. The caller always resolves this from the
   *  environment (same convention `BlobFreePoolBudget`/`AzureBlobBackend`
   *  already use via `AZURE_USER_CONTENT_CONTAINER`) and passes it
   *  explicitly — never omitted. */
  container: string;
  /** Default `'overlay-state'`. */
  blobPrefix?: string;
  /** Bounded retries on an ETag CAS conflict (412) for a per-entry stage,
   *  before giving up as `'storage_unavailable'`. Default 5. The `_gen`
   *  bump itself is never retried this way — it's unconditional (D1). */
  maxCasRetries?: number;
  /** Test seam: inject a pre-built client (e.g. an Azurite shared-key client). */
  serviceClient?: BlobServiceClient;
}

export type SharedOverlayStageResult =
  | { ok: true }
  | { ok: false; reason: 'storage_unavailable' };

function isNotFound(err: unknown): boolean {
  return err instanceof RestError ? (err.statusCode === 404 || err.code === 'BlobNotFound') : false;
}

function isPreconditionFailed(err: unknown): boolean {
  return err instanceof RestError && err.statusCode === 412;
}

function wrapOverlayError(err: unknown, op: string, blobName: string): ActionableError {
  return new ActionableError({
    goal: `Shared overlay store ${op}`,
    problem: `Overlay store operation "${op}" failed for "${blobName}": ${(err as Error)?.message ?? String(err)}`,
    location: `SharedOverlayStore.${op}`,
    nextSteps: [
      'Verify the storage account is reachable and the managed identity has data-plane access',
      'Check Azure Blob service health and retry',
    ],
    innerError: err,
  });
}

/** Collision-free, reversible encoding — never a lossy slug (TL t/4311#16). */
export function encodePathKey(repoPath: string): string {
  return Buffer.from(repoPath, 'utf-8').toString('base64url');
}

export function decodePathKey(pathKey: string): string {
  return Buffer.from(pathKey, 'base64url').toString('utf-8');
}

const DEFAULT_BLOB_PREFIX = 'overlay-state';
const DEFAULT_MAX_CAS_RETRIES = 5;

export class SharedOverlayStore {
  private readonly containerClient: ContainerClient;
  private readonly blobPrefix: string;
  private readonly maxCasRetries: number;

  constructor(opts: SharedOverlayStoreOptions) {
    const service = opts.serviceClient
      ?? new BlobServiceClient(opts.accountUrl, new DefaultAzureCredential());
    this.containerClient = service.getContainerClient(opts.container);
    this.blobPrefix = opts.blobPrefix ?? DEFAULT_BLOB_PREFIX;
    this.maxCasRetries = opts.maxCasRetries ?? DEFAULT_MAX_CAS_RETRIES;
  }

  private entryBlobClient(userId: string, pathKey: string): BlockBlobClient {
    return this.containerClient.getBlockBlobClient(`${this.blobPrefix}/${userId}/${pathKey}.json`);
  }

  private genBlobClient(userId: string): BlockBlobClient {
    return this.containerClient.getBlockBlobClient(`${this.blobPrefix}/${userId}/_gen`);
  }

  /** Unconditional PUT of a fresh nonce (D1) — never CAS, never retried on
   *  412 (there is no conditional to fail). A thrown error here is a
   *  genuine store failure; the caller decides what that means for the
   *  write that triggered it (see `stage()`'s D2 handling). */
  private async bumpGeneration(userId: string): Promise<void> {
    const client = this.genBlobClient(userId);
    const body = randomUUID();
    try {
      await client.upload(body, Buffer.byteLength(body));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'error',
        message: `_gen bump failed: ${client.name}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw err instanceof ActionableError ? err : wrapOverlayError(err, 'bumpGeneration', client.name);
    }
  }

  /** Stage one path's content, ETag-conditional (CAS, bounded retry) so two
   *  replicas racing the SAME path's write never silently clobber each
   *  other — same-user DIFFERENT-path writes never contend here at all,
   *  since each path has its own blob.
   *
   *  Not acknowledged (`{ ok: true }`) until the `_gen` bump lands (D1/D2):
   *  on a bump failure, the just-written entry is deleted before returning
   *  `{ ok: false }`, so an entry only ever exists in the store once its
   *  write was successfully acknowledged. */
  async stage(userId: string, repoPath: string, entry: SharedOverlayEntry): Promise<SharedOverlayStageResult> {
    const pathKey = encodePathKey(repoPath);
    const client = this.entryBlobClient(userId, pathKey);
    const body = JSON.stringify(entry);
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.maxCasRetries; attempt++) {
      let current: { etag: string } | null;
      try {
        current = await this.readEntryEtag(client);
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'shared-overlay-store', level: 'error',
          message: `stage failed reading current entry etag; refusing (fail closed): ${client.name}`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        return { ok: false, reason: 'storage_unavailable' };
      }
      let writtenEtag: string | undefined;
      try {
        const uploadResp = await client.upload(body, Buffer.byteLength(body), {
          conditions: current ? { ifMatch: current.etag } : { ifNoneMatch: '*' },
        });
        writtenEtag = uploadResp.etag;
      } catch (err) {
        if (isPreconditionFailed(err)) { lastErr = err; continue; } // lost the race — re-read and retry
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'shared-overlay-store', level: 'error',
          message: `stage upload failed; refusing (fail closed): ${client.name}`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        return { ok: false, reason: 'storage_unavailable' };
      }
      // Entry write landed — now the D1/D2/F2 generation bump + cleanup.
      if (await this.bumpGenerationOrCleanup(userId, client, writtenEtag)) return { ok: true };
      return { ok: false, reason: 'storage_unavailable' };
    }
    return this.failStorageUnavailable(lastErr ?? new Error('CAS retries exhausted'), 'stage', client.name);
  }

  /** Extracted from stage() to keep its own complexity under budget. Returns
   *  `true` on a successful bump (the write is now acknowledged), `false` on
   *  a bump failure (cleanup already attempted internally per D2/E1/F2). */
  private async bumpGenerationOrCleanup(userId: string, client: BlockBlobClient, writtenEtag: string | undefined): Promise<boolean> {
    try {
      await this.bumpGeneration(userId);
      return true;
    } catch (bumpErr) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'warn',
        message: `_gen bump failed after a successful entry write — deleting the unacknowledged entry: ${client.name}`,
        error: { name: (bumpErr as Error).name ?? 'Error', message: String(bumpErr), stack: (bumpErr as Error).stack },
      });
      // SO e/332#10 E1: delete conditional on OUR OWN just-written ETag.
      // Without this, if another replica staged the same path and was
      // acknowledged between our upload and our failed bump, an
      // unconditional delete here would destroy that already-acknowledged
      // write — a silent lost update, not an unacknowledged-entry cleanup.
      //
      // F2 (SO e/332#12): if upload() itself returned no ETag, we have no
      // safe precondition to delete with — `ifMatch: undefined` would
      // silently become an unconditional delete, reintroducing E1. Skip
      // the cleanup entirely rather than risk it; the orphan sweep (a
      // separate follow-up PR) is the backstop for this already-rare case.
      if (writtenEtag) {
        await this.deleteUnacknowledgedEntry(client, writtenEtag);
      } else {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'shared-overlay-store', level: 'warn',
          message: `Skipped unacknowledged-entry cleanup — upload() returned no ETag to delete conditionally on: ${client.name}`,
          data: { blobName: client.name },
        });
      }
      return false;
    }
  }

  /** D2: the bump failed (WARN-logged by the caller, `stage()`), so the
   *  write this entry represents was never acknowledged to the caller.
   *  Delete it, conditional on `ifMatch: ourEtag` (SO e/332#10 E1) — our own
   *  ETag from the upload that just succeeded. If another replica staged
   *  the SAME path and was acknowledged in the gap between our upload and
   *  our failed bump, its write now has a different ETag, the delete gets
   *  a 412, and we correctly do nothing — their acknowledged edit survives.
   *  Best-effort beyond that: if the conditional delete itself fails for a
   *  genuine store reason, the orphan-TTL sweep (a separate follow-up PR)
   *  is the backstop. */
  private async deleteUnacknowledgedEntry(client: BlockBlobClient, ourEtag: string): Promise<void> {
    try {
      await client.deleteIfExists({ conditions: { ifMatch: ourEtag } });
    } catch (deleteErr) {
      if (isPreconditionFailed(deleteErr)) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'shared-overlay-store', level: 'warn',
          message: `Unacknowledged-entry cleanup skipped — the entry changed since our write (another replica's acknowledged edit survives): ${client.name}`,
          data: { blobName: client.name },
        });
        return;
      }
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'warn',
        message: `Failed to delete an unacknowledged entry after a _gen bump failure — it will be caught by the orphan sweep: ${client.name}`,
        error: { name: (deleteErr as Error).name ?? 'Error', message: String(deleteErr), stack: (deleteErr as Error).stack },
      });
    }
  }

  private failStorageUnavailable(err: unknown, op: string, blobName: string): SharedOverlayStageResult {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'shared-overlay-store', level: 'error',
      message: `${op} failed; refusing (fail closed): ${blobName}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return { ok: false, reason: 'storage_unavailable' };
  }

  /** Remove a staged entry (the user discarded a draft, or the commit path
   *  — a separate follow-up PR — is clearing a committed one). Bumps `_gen`
   *  best-effort after a real delete: unlike `stage()`, a bump failure here
   *  has no compensating action to take (there is nothing to "un-delete"),
   *  so it's WARN-logged and left for the orphan sweep rather than failing
   *  the caller — a reader on a stale generation simply keeps seeing the
   *  entry for a bit longer, which is a staleness window, not a
   *  lost-update risk.
   *
   *  `opts.ifMatch` (SO e/332#10 E3): the commit path (a separate follow-up
   *  PR) needs S2's "clear only if unchanged since the commit's snapshot"
   *  semantics — pass the ETag `listEntries` returned for this path, and a
   *  412 (someone restaged it since) returns `'changed'` instead of
   *  deleting, so the newer edit is never silently discarded. Without
   *  `ifMatch`, the delete is unconditional, matching the "user discarded a
   *  draft" caller's intent (always remove whatever is there now).
   *
   *  F1 (SO e/332#12): a genuine delete failure returns `'failed'`, never
   *  `'deleted'` — the S2 commit-path caller must not believe the entry is
   *  cleared when it isn't, or the stale entry trips t/4312's fence as a
   *  false conflict on the user's own already-committed edit. */
  async unstage(userId: string, repoPath: string, opts?: { ifMatch?: string }): Promise<'deleted' | 'changed' | 'failed'> {
    const pathKey = encodePathKey(repoPath);
    const client = this.entryBlobClient(userId, pathKey);
    try {
      await client.deleteIfExists(opts?.ifMatch ? { conditions: { ifMatch: opts.ifMatch } } : undefined);
    } catch (err) {
      if (isPreconditionFailed(err)) return 'changed';
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'warn',
        message: `unstage delete failed: ${client.name}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return 'failed';
    }
    try {
      await this.bumpGeneration(userId);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'warn',
        message: `_gen bump failed after unstage — readers on a stale generation will see this entry a bit longer: ${userId}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
    return 'deleted';
  }

  /** Direct read of one path's staged entry, `null` if none exists. */
  async getEntry(userId: string, repoPath: string): Promise<SharedOverlayEntry | null> {
    const got = await this.getEntryWithEtag(userId, repoPath);
    return got?.entry ?? null;
  }

  /** Same as `getEntry`, plus the ETag `listEntries` needs for S2's
   *  "clear only if unchanged" semantics (SO e/332#10 E3) — exposed
   *  separately so `getEntry`'s public contract (just the entry) stays
   *  unchanged for callers that don't need it. */
  private async getEntryWithEtag(userId: string, repoPath: string): Promise<{ entry: SharedOverlayEntry; etag: string } | null> {
    const pathKey = encodePathKey(repoPath);
    const client = this.entryBlobClient(userId, pathKey);
    try {
      const resp = await client.download();
      const chunks: Buffer[] = [];
      for await (const chunk of resp.readableStreamBody ?? []) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array | string));
      }
      const entry = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as SharedOverlayEntry;
      if (!resp.etag) throw wrapOverlayError(new Error('download succeeded but returned no ETag'), 'getEntryWithEtag', client.name);
      return { entry, etag: resp.etag };
    } catch (err) {
      if (isNotFound(err)) return null;
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'error',
        message: `getEntry failed: ${client.name}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw err instanceof ActionableError ? err : wrapOverlayError(err, 'getEntry', client.name);
    }
  }

  /** The user's current generation token, or `null` if they've never staged
   *  anything (the `_gen` blob doesn't exist yet). */
  async getGeneration(userId: string): Promise<string | null> {
    const client = this.genBlobClient(userId);
    try {
      const resp = await client.download();
      const chunks: Buffer[] = [];
      for await (const chunk of resp.readableStreamBody ?? []) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array | string));
      }
      return Buffer.concat(chunks).toString('utf-8');
    } catch (err) {
      if (isNotFound(err)) return null;
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'error',
        message: `getGeneration failed: ${client.name}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw err instanceof ActionableError ? err : wrapOverlayError(err, 'getGeneration', client.name);
    }
  }

  /** All currently-staged entries for a user — the primitive the (separate,
   *  follow-up-PR) read path and commit path both build on: the read path
   *  calls this only after `getGeneration()` shows a change since the
   *  caller's last-seen value; the commit path calls it unconditionally to
   *  find everything to commit. */
  async listEntries(userId: string): Promise<Array<{ repoPath: string; pathKey: string; entry: SharedOverlayEntry; etag: string }>> {
    const prefix = `${this.blobPrefix}/${userId}/`;
    const out: Array<{ repoPath: string; pathKey: string; entry: SharedOverlayEntry; etag: string }> = [];
    try {
      for await (const blob of this.containerClient.listBlobsFlat({ prefix })) {
        const name = blob.name.slice(prefix.length);
        if (name === '_gen' || !name.endsWith('.json')) continue;
        const pathKey = name.slice(0, -'.json'.length);
        const repoPath = decodePathKey(pathKey);
        const got = await this.getEntryWithEtag(userId, repoPath);
        if (got) out.push({ repoPath, pathKey, entry: got.entry, etag: got.etag });
      }
      return out;
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'error',
        message: `listEntries failed: ${prefix}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw err instanceof ActionableError ? err : wrapOverlayError(err, 'listEntries', prefix);
    }
  }

  private async readEntryEtag(client: BlockBlobClient): Promise<{ etag: string } | null> {
    try {
      const props = await client.getProperties();
      if (!props.etag) throw wrapOverlayError(new Error('getProperties succeeded but returned no ETag'), 'readEntryEtag', client.name);
      return { etag: props.etag };
    } catch (err) {
      // SO e/332#10 minor: no record here — this fires on EVERY first stage
      // of EVERY new path (the common case, not a degraded one), so a WARN
      // per occurrence would flood the flight recorder for routine traffic.
      // Same "expected, not exceptional" status as the 412-retry branch in
      // stage()'s own loop just above, which is likewise unrecorded.
      if (isNotFound(err)) return null; /* telemetry — silent by design: routine "no entry yet", not a degraded condition */
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'error',
        message: `readEntryEtag failed: ${client.name}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw err;
    }
  }
}
