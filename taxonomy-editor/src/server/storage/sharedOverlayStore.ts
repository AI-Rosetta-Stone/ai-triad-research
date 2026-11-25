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
 * **The acknowledgment point is the entry's conditional upload (t/549; SO t/503#10, TL t/503#11).**
 * This replaces D2 and E1 from e/332, which deleted the just-written entry when the `_gen` bump
 * failed. Under t/503's option 2 the save is acknowledged only after its stage, so the invariant is:
 * an entry exists in the store if and only if the caller was told its save succeeded.
 * - A successful conditional upload is a successful save, with or without an ETag in the response.
 * - A `_gen` bump failure after that still returns ok (`genBumped: false`, WARN). The entry is
 *   durable and the commit lists the store directly, so a missed bump costs only freshness for other
 *   replicas' reads, bounded by the reader's periodic re-list (`SHARED_OVERLAY_RELIST_MS`).
 * - There is no delete-on-failure path, so no orphan can exist and no sweep is needed. The old
 *   delete also removed another replica's acknowledged value when ours had overwritten it.
 * - An ambiguous upload failure (no status, a timeout, or a 5xx) can have landed without the caller
 *   knowing, so `stage()` reads the entry back once: it is ours if its `stageId` matches.
 * - Every upload is conditional (ifMatch or ifNoneMatch). The caller says which in `expect`; the
 *   store never re-uploads blindly after a 412.
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
  /** t/549: `null` means the file did not exist on the branch when the path was first staged, matching
   *  the local map's convention. Entries already staged as `'unknown'` always conflict, which is safe. */
  baseSha: string | null | 'unknown';
  /** Set once, when the save arrives, and never refreshed on a retry (SO t/503#14 condition 1). */
  stagedAt: string;
  /** t/549: a random id per save, set once like `stagedAt`. The ambiguous-failure read-back compares
   *  it (SO t/503#14 condition 4). Absent only on entries written before t/549. */
  stageId?: string;
}

/** The precondition for one stage. The store turns it into ifMatch / ifNoneMatch; the caller's semantic
 *  check (baseSha against the entry, or 'absent') happens before, on what it read.
 *  - `etag`: the entry the caller read and checked must still be there unchanged.
 *  - `absent`: there must be no entry (the caller checked the branch file itself).
 *  - `latestWins`: no semantic precondition (deletes, and the logged no-baseSha write). Still ifMatch on
 *    the ETag just read, so a 412 re-reads; an entry with a later `stagedAt` is never overwritten. */
export type SharedOverlayStageExpect = { etag: string } | { absent: true } | { latestWins: true };

export type SharedOverlayEntryWithEtag = { entry: SharedOverlayEntry; etag: string };

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
  /** Bounded retries on an ETag CAS conflict (412) for a `latestWins` stage,
   *  before giving up as `'storage_unavailable'`. Default 5. `etag` / `absent` stages
   *  never retry inside the store: the caller re-checks and bounds its own loop (t/549). The `_gen`
   *  bump itself is never retried this way — it's unconditional (D1). */
  maxCasRetries?: number;
  /** Test seam: inject a pre-built client (e.g. an Azurite shared-key client). */
  serviceClient?: BlobServiceClient;
}

/** t/549. `ok: true` means the save is acknowledged: the entry is in the store.
 *  - `precondition_failed` (`etag` / `absent` only): the entry changed since the caller read it, or
 *    appeared; `current` is what is there now, for the caller's bounded re-check.
 *  - `newer_exists` (`latestWins` only): a 412 re-read found an entry staged later than ours. It is not
 *    overwritten; the caller reports success, ordered before it (the two saves overlapped).
 *  - `storage_unavailable`: a definite failure; nothing of ours is in the store. */
export type SharedOverlayStageResult =
  | { ok: true; etag: string | null; gen: string | null; genBumped: boolean }
  | { ok: false; reason: 'precondition_failed'; current: SharedOverlayEntryWithEtag | null }
  | { ok: false; reason: 'newer_exists'; current: SharedOverlayEntryWithEtag }
  | { ok: false; reason: 'storage_unavailable' };

/** An upload error after which the write may or may not have landed: no HTTP status at all (a
 *  network error or a client-side timeout), a request timeout, or a server error. */
function isAmbiguousUploadFailure(err: unknown): boolean {
  if (!(err instanceof RestError) || err.statusCode === undefined) return true;
  return err.statusCode === 408 || err.statusCode >= 500;
}

function isLater(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta > tb;
}

function isNotFound(err: unknown): boolean {
  return err instanceof RestError ? (err.statusCode === 404 || err.code === 'BlobNotFound') : false;
}

function isPreconditionFailed(err: unknown): boolean {
  return err instanceof RestError && err.statusCode === 412;
}

/** t/549: an upload's condition was not met. ifMatch answers 412; ifNoneMatch '*' on a blob that exists
 *  answers 409 BlobAlreadyExists, not 412 (seen on Azurite; the same is documented for Put Blob). */
function isUploadConditionNotMet(err: unknown): boolean {
  return isPreconditionFailed(err) || (err instanceof RestError && err.statusCode === 409 && err.code === 'BlobAlreadyExists');
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
   *  write that triggered it (`stage()` acknowledges the save anyway, t/549). */
  private async bumpGeneration(userId: string): Promise<string> {
    const client = this.genBlobClient(userId);
    const body = randomUUID();
    try {
      await client.upload(body, Buffer.byteLength(body));
      return body;
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'error',
        message: `_gen bump failed: ${client.name}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw err instanceof ActionableError ? err : wrapOverlayError(err, 'bumpGeneration', client.name);
    }
  }

  /** Stage one path's content under the caller's precondition (t/549; see the header). Different paths
   *  never contend, since each path has its own blob.
   *
   *  `etag` / `absent`: one conditional upload. A 412 returns `precondition_failed` with what is there
   *  now, so the caller re-runs its semantic check; the store never re-uploads on its own. `latestWins`:
   *  read, then upload ifMatch / ifNoneMatch on what was read, up to `maxCasRetries` times; an entry
   *  with a later `stagedAt` is never overwritten (`newer_exists`).
   *
   *  `entry.stagedAt` and `entry.stageId` are the caller's, set once per save; they are written as given.
   *
   *  **Our own write behind a failed condition (Quality on #5459).** The SDK retries an upload whose
   *  response was lost. If the first attempt landed, the retry's condition fails against our own write
   *  (412, or 409 for ifNoneMatch). So whenever a condition fails, the entry found is checked first: if
   *  its `stageId` is ours, the save landed and is acknowledged.
   *
   *  **Read-back window.** The read-back after an ambiguous failure, and the re-read after a failed
   *  condition, see only what the store holds at that moment. A write the service applies after that read
   *  (a request still in flight when the client gave up) is reported as not saved although it exists. That
   *  is the one residual case of "exists but not acknowledged"; a later save of the path replaces it, and
   *  its content was the user's own intended edit.
   *
   *  **stagedAt ordering** (`latestWins` only) uses replica clocks. Skew between replicas can order two
   *  overlapping saves either way. That is acceptable only because `newer_exists` arises only when the two
   *  saves were in flight together, where either order is a valid outcome (SO t/503#14). */
  async stage(userId: string, repoPath: string, entry: SharedOverlayEntry & { stageId: string }, expect: SharedOverlayStageExpect): Promise<SharedOverlayStageResult> {
    const client = this.entryBlobClient(userId, encodePathKey(repoPath));
    if ('latestWins' in expect) return this.stageLatestWins(userId, repoPath, client, entry);

    const conditions = 'etag' in expect ? { ifMatch: expect.etag } : { ifNoneMatch: '*' };
    const uploaded = await this.conditionalUpload(userId, repoPath, client, entry, conditions);
    if (uploaded.kind === 'precondition_failed') return this.preconditionFailed(userId, repoPath, client, entry.stageId);
    if (uploaded.kind === 'failed') return { ok: false, reason: 'storage_unavailable' };
    return this.acknowledge(userId, client, uploaded.etag);
  }

  private async stageLatestWins(userId: string, repoPath: string, client: BlockBlobClient, entry: SharedOverlayEntry & { stageId: string }): Promise<SharedOverlayStageResult> {
    for (let attempt = 0; attempt < this.maxCasRetries; attempt++) {
      let current: SharedOverlayEntryWithEtag | null;
      try {
        current = await this.getEntryWithEtag(userId, repoPath);
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'shared-overlay-store', level: 'error',
          message: `stage (latestWins) could not read the current entry; refusing (fail closed): ${client.name}`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        return { ok: false, reason: 'storage_unavailable' };
      }
      // A previous attempt's upload landed although its condition then failed on an SDK retry (see stage()).
      if (current && current.entry.stageId === entry.stageId) return this.acknowledge(userId, client, current.etag);
      if (current && isLater(current.entry.stagedAt, entry.stagedAt)) return { ok: false, reason: 'newer_exists', current };
      const conditions = current ? { ifMatch: current.etag } : { ifNoneMatch: '*' };
      const uploaded = await this.conditionalUpload(userId, repoPath, client, entry, conditions);
      if (uploaded.kind === 'precondition_failed') continue; // lost a race: re-read, re-compare stagedAt
      if (uploaded.kind === 'failed') return { ok: false, reason: 'storage_unavailable' };
      return this.acknowledge(userId, client, uploaded.etag);
    }
    return this.failStorageUnavailable(new Error(`CAS retries exhausted (${this.maxCasRetries})`), 'stage', client.name);
  }

  /** One conditional upload. An ambiguous failure gets one read-back: the write is ours, and landed,
   *  only if the entry's `stageId` is ours (SO t/503#14 condition 4). */
  private async conditionalUpload(
    userId: string, repoPath: string, client: BlockBlobClient, entry: SharedOverlayEntry & { stageId: string },
    conditions: { ifMatch: string } | { ifNoneMatch: string },
  ): Promise<{ kind: 'ok'; etag: string | null } | { kind: 'precondition_failed' } | { kind: 'failed' }> {
    const body = JSON.stringify(entry);
    try {
      const resp = await client.upload(body, Buffer.byteLength(body), { conditions });
      // A 2xx without an ETag still landed (t/503#12 / #14): ok, with no read-back.
      return { kind: 'ok', etag: resp.etag ?? null };
    } catch (err) {
      if (isUploadConditionNotMet(err)) return { kind: 'precondition_failed' };
      if (!isAmbiguousUploadFailure(err)) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'shared-overlay-store', level: 'error',
          message: `stage upload failed (definite); nothing written: ${client.name}`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        return { kind: 'failed' };
      }
      return this.readBackAfterAmbiguousFailure(userId, repoPath, client, entry.stageId, err);
    }
  }

  private async readBackAfterAmbiguousFailure(
    userId: string, repoPath: string, client: BlockBlobClient, stageId: string, uploadErr: unknown,
  ): Promise<{ kind: 'ok'; etag: string | null } | { kind: 'failed' }> {
    let back: SharedOverlayEntryWithEtag | null;
    try {
      back = await this.getEntryWithEtag(userId, repoPath);
    } catch (readErr) {
      // The upload's outcome stays unknown, so it is not acknowledged.
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'error',
        message: `stage upload failed ambiguously (${String(uploadErr)}) and the read-back failed; reported as not saved: ${client.name}`,
        error: { name: (readErr as Error).name ?? 'Error', message: String(readErr), stack: (readErr as Error).stack },
      });
      return { kind: 'failed' };
    }
    if (back && back.entry.stageId === stageId) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'warn',
        message: `stage upload failed ambiguously but the read-back shows it landed; acknowledged: ${client.name}`,
        error: { name: (uploadErr as Error).name ?? 'Error', message: String(uploadErr), stack: (uploadErr as Error).stack },
      });
      return { kind: 'ok', etag: back.etag };
    }
    this.recordFailure('stage upload failed ambiguously and the read-back shows it did not land; reported as not saved', client.name, uploadErr);
    return { kind: 'failed' };
  }

  private async preconditionFailed(userId: string, repoPath: string, client: BlockBlobClient, stageId: string): Promise<SharedOverlayStageResult> {
    let current: SharedOverlayEntryWithEtag | null;
    try {
      current = await this.getEntryWithEtag(userId, repoPath);
    } catch (err) {
      // The re-read failed, so whether an SDK retry hid our own landed write is unknown: not acknowledged.
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'error',
        message: `stage could not re-read the entry after its condition failed; refusing: ${client.name}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return { ok: false, reason: 'storage_unavailable' };
    }
    // Our own write, landed on an earlier SDK attempt (see stage()): the save succeeded.
    if (current && current.entry.stageId === stageId) return this.acknowledge(userId, client, current.etag);
    return { ok: false, reason: 'precondition_failed', current };
  }

  /** The upload landed, so the save is acknowledged whatever happens to the `_gen` bump. */
  private async acknowledge(userId: string, client: BlockBlobClient, etag: string | null): Promise<SharedOverlayStageResult> {
    try {
      const gen = await this.bumpGeneration(userId);
      return { ok: true, etag, gen, genBumped: true };
    } catch (bumpErr) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'warn',
        message: `_gen bump failed after a successful entry write; the save is acknowledged, other replicas see it at their next periodic re-list: ${client.name}`,
        error: { name: (bumpErr as Error).name ?? 'Error', message: String(bumpErr), stack: (bumpErr as Error).stack },
      });
      return { ok: true, etag, gen: null, genBumped: false };
    }
  }

  /** Compare-and-set of an entry's `baseSha` only (t/549, t/503#3): after a commit, a path rewritten
   *  during it keeps its newer content but must be based on the blob just committed, or the next commit
   *  sees a false conflict. Content, `stagedAt` and `stageId` are kept. `'changed'` means the entry is no
   *  longer the one at `ifMatch` (or is gone); `'failed'` is a store error. */
  async rebaseEntry(userId: string, repoPath: string, opts: { ifMatch: string; baseSha: string | null }): Promise<'rebased' | 'changed' | 'failed'> {
    const client = this.entryBlobClient(userId, encodePathKey(repoPath));
    let current: SharedOverlayEntryWithEtag | null;
    try {
      current = await this.getEntryWithEtag(userId, repoPath);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'error',
        message: `rebaseEntry could not read the entry: ${client.name}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return 'failed';
    }
    if (!current || current.etag !== opts.ifMatch) return 'changed';
    const uploaded = await this.uploadRebase(userId, repoPath, client, current.entry, opts);
    if (uploaded !== 'rebased') return uploaded;
    try {
      await this.bumpGeneration(userId);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'warn',
        message: `_gen bump failed after rebaseEntry; readers see the new base at their next periodic re-list: ${client.name}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
    return 'rebased';
  }

  /** Extracted from rebaseEntry() to keep its complexity under budget: the conditional upload of the new base. */
  private async uploadRebase(
    userId: string, repoPath: string, client: BlockBlobClient, before: SharedOverlayEntry, opts: { ifMatch: string; baseSha: string | null },
  ): Promise<'rebased' | 'changed' | 'failed'> {
    const body = JSON.stringify({ ...before, baseSha: opts.baseSha });
    try {
      await client.upload(body, Buffer.byteLength(body), { conditions: { ifMatch: opts.ifMatch } });
      return 'rebased';
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: isPreconditionFailed(err) ? 'warn' : 'error',
        message: `rebaseEntry upload failed (${isPreconditionFailed(err) ? 'condition not met' : 'store error'}): ${client.name}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      if (!isPreconditionFailed(err)) return 'failed';
      // A 412 can be an SDK retry hitting our own landed rebase (see stage()): same save, our new base.
      return (await this.isOwnRebase(userId, repoPath, before, opts.baseSha)) ? 'rebased' : 'changed';
    }
  }

  /** True when the entry now holds the same save (`stageId`) with the base we just wrote. */
  private async isOwnRebase(userId: string, repoPath: string, before: SharedOverlayEntry, baseSha: string | null): Promise<boolean> {
    try {
      const now = await this.getEntryWithEtag(userId, repoPath);
      return !!now && before.stageId !== undefined && now.entry.stageId === before.stageId && now.entry.baseSha === baseSha;
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'warn',
        message: `rebaseEntry could not re-read after a failed condition; reporting 'changed': ${repoPath}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return false;
    }
  }

  private recordFailure(message: string, blobName: string, err: unknown): void {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'shared-overlay-store', level: 'error',
      message: `${message}: ${blobName}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
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
   *  so it's WARN-logged rather than failing
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
  async getEntryWithEtag(userId: string, repoPath: string): Promise<SharedOverlayEntryWithEtag | null> {
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

  private statusBlobClient(userId: string): BlockBlobClient {
    // No `.json` suffix, so listEntries never lists it as a staged path.
    return this.containerClient.getBlockBlobClient(`${this.blobPrefix}/${userId}/_status`);
  }

  /** t/551: write the user's overlay commit status, so any replica can answer the sync-status route. Unconditional
   *  (last writer wins): each write is a whole, current status. Throws a wrapped error on a store failure. */
  async writeCommitStatus(userId: string, status: unknown): Promise<void> {
    const client = this.statusBlobClient(userId);
    const body = JSON.stringify(status);
    try {
      await client.upload(body, Buffer.byteLength(body));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'warn',
        message: `writeCommitStatus failed: ${client.name}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw wrapOverlayError(err, 'writeCommitStatus', client.name);
    }
  }

  /** t/551: the user's last written commit status, or null if none was written. Throws a wrapped error on a store failure. */
  async readCommitStatus(userId: string): Promise<unknown> {
    const client = this.statusBlobClient(userId);
    try {
      const resp = await client.download();
      const chunks: Buffer[] = [];
      for await (const chunk of resp.readableStreamBody ?? []) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array | string));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
    } catch (err) {
      if (isNotFound(err)) return null;
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'shared-overlay-store', level: 'warn',
        message: `readCommitStatus failed: ${client.name}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw err instanceof ActionableError ? err : wrapOverlayError(err, 'readCommitStatus', client.name);
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
}
