// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * AzureBlobBackend — StorageBackend over Azure Blob Storage (t/697).
 *
 * Replaces the GitHub-API / filesystem backends for the Azure Blob storage
 * migration (epic t/695). Two containers:
 *   - community     ← paths under `community/` (shared, admin-curated)
 *   - user-content  ← everything else (taxonomy, debates, calibration, …)
 *
 * Blob names are the data-root-relative path (forward-slash normalized), e.g.
 * `taxonomy/Origin/nodes.json` or `community/_submissions/sub-x.json` — the same
 * relative layout the other backends use, so the container is the only routing
 * decision. Blob Storage has no directories (virtual dirs via `/` delimiter) and
 * no branches, so `opts.ref` is ignored.
 *
 * Auth: DefaultAzureCredential (Managed Identity in Azure, az-CLI locally). No
 * connection strings. Tests inject a shared-key client via `opts.serviceClient`.
 */

import path from 'path';
import { BlobServiceClient, type ContainerClient, RestError } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { getDataRoot } from '../config.js';
import type { StorageBackend } from './storageBackend.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { gitBlobSha } from './gitBlobSha.js';

export interface AzureBlobBackendOptions {
  /** e.g. https://<account>.blob.core.windows.net — from AZURE_STORAGE_ACCOUNT_URL. */
  accountUrl: string;
  /** Container for general user content (default routing target). */
  userContentContainer: string;
  /** Container for shared `community/` data. */
  communityContainer: string;
  /**
   * Test seam: inject a pre-built BlobServiceClient (e.g. an Azurite shared-key
   * client). Production omits this → a client is built from accountUrl +
   * DefaultAzureCredential.
   */
  serviceClient?: BlobServiceClient;
  /** Server-side timeout for blob uploads (ms). Default 60s. Test seam. */
  uploadTimeoutMs?: number;
}

async function streamToBuffer(readable: NodeJS.ReadableStream | undefined): Promise<Buffer> {
  if (!readable) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array | string));
  }
  return Buffer.concat(chunks);
}

/** Treat BlobNotFound / 404 as a missing file rather than an error. */
function isNotFound(err: unknown): boolean {
  return err instanceof RestError
    ? (err.statusCode === 404 || err.code === 'BlobNotFound')
    : false;
}

/** Record a Blob error to the flight recorder (incl. stack) for trace debugging. */
function recordBlobError(err: unknown, op: string, blob: string, level: 'warn' | 'error'): void {
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'azure-blob-backend',
    level,
    message: `${op} failed: ${blob}`,
    error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
  });
}

/** Record + wrap a raw Blob SDK error in an ActionableError. Preserves the
 *  original error via innerError (stack). Never includes credentials — auth is
 *  via the credential object, not the message. */
function wrapBlobError(err: unknown, op: string, blob: string): ActionableError {
  return new ActionableError({
    goal: `Azure Blob ${op}`,
    problem: `Blob operation "${op}" failed for "${blob}": ${(err as Error)?.message ?? String(err)}`,
    location: `AzureBlobBackend.${op}`,
    nextSteps: [
      'Verify the storage account is reachable and the managed identity has data-plane access',
      'Check Azure Blob service health and retry; the operation is idempotent',
    ],
    innerError: err,
  });
}

/** t/4191: the conflict shape writeFile throws on a stale/missing baseSha or
 *  a rejected If-Match/If-None-Match precondition — same code/status either way
 *  so callers don't need to distinguish "someone else changed it" (412) from
 *  "someone else changed it, and we noticed before even trying" (hash mismatch). */
function writeConflictError(filePath: string, blob: string): ActionableError {
  return new ActionableError({
    goal: `Save ${filePath}`,
    problem: 'The file changed since you loaded it (someone else saved a conflicting change).',
    location: `AzureBlobBackend.writeFile(${blob})`,
    nextSteps: ['Reload the file to see the latest version', 'Re-apply your change and save again'],
    httpStatus: 409,
    code: 'WRITE_CONFLICT',
  });
}

/** Blob service returns 412 for both a failed If-Match and a failed If-None-Match. */
function isPreconditionFailed(err: unknown): boolean {
  return err instanceof RestError && err.statusCode === 412;
}

const DEFAULT_BLOB_UPLOAD_TIMEOUT_MS = 60_000;

export class AzureBlobBackend implements StorageBackend {
  readonly backendName = 'azure-blob';

  private readonly userContentClient: ContainerClient;
  private readonly communityClient: ContainerClient;
  private readonly uploadTimeoutMs: number;

  constructor(opts: AzureBlobBackendOptions) {
    const service = opts.serviceClient
      ?? new BlobServiceClient(opts.accountUrl, new DefaultAzureCredential());
    this.userContentClient = service.getContainerClient(opts.userContentContainer);
    this.communityClient = service.getContainerClient(opts.communityContainer);
    this.uploadTimeoutMs = opts.uploadTimeoutMs ?? DEFAULT_BLOB_UPLOAD_TIMEOUT_MS;
  }

  /** Convert an absolute or relative path to a forward-slash, data-root-relative blob name. */
  private toBlobPath(filePath: string): string {
    let p = filePath.replace(/\\/g, '/');
    const root = getDataRoot().replace(/\\/g, '/');
    if (p === root) p = '';
    else if (p.startsWith(root + '/')) p = p.slice(root.length + 1);
    p = p.replace(/^\/+/, '');
    if (p === '') return '';
    // Normalize BEFORE the traversal check so sequences that resolve to an
    // escape (e.g. "a/../../b" → "../b") are caught, not just literal ".." segments.
    const normalized = path.posix.normalize(p).replace(/\/+$/, '');
    if (
      normalized === '..' || normalized.startsWith('../') ||
      normalized === '.git' || normalized.startsWith('.git/')
    ) {
      throw new ActionableError({
        goal: 'Resolve blob path',
        problem: `Rejected unsafe path: "${filePath}"`,
        location: 'AzureBlobBackend.toBlobPath',
        nextSteps: ['Use a clean path within the data root'],
      });
    }
    return normalized;
  }

  /** Route to the community container for `community/…`, else user-content. */
  private containerFor(blobPath: string): ContainerClient {
    return blobPath === 'community' || blobPath.startsWith('community/')
      ? this.communityClient
      : this.userContentClient;
  }

  async readFile(filePath: string, _opts?: { ref?: string; optional?: boolean }): Promise<string | null> {
    return (await this.readBinaryFile(filePath))?.toString('utf-8') ?? null;
  }

  /** t/4201 (p/775#31): version is the content's git blob SHA (gitBlobSha), the
   *  same hash writeFile's baseSha precondition checks against — not Blob's own
   *  native ETag, which is tracked internally (downloadWithEtag) purely to
   *  drive writeFile's If-Match/If-None-Match (t/4191). */
  async readFileWithVersion(filePath: string, opts?: { ref?: string }): Promise<{ content: string; version: string } | null> {
    const content = await this.readFile(filePath, opts);
    return content === null ? null : { content, version: gitBlobSha(content) };
  }

  async readBinaryFile(filePath: string): Promise<Buffer | null> {
    return (await this.downloadWithEtag(filePath))?.content ?? null;
  }

  /**
   * t/4191: one `download()` call is the sole source of both the content used
   * to verify a caller's `baseSha` and the ETag passed as `If-Match` — reusing
   * a value from a *second* call (e.g. a follow-up `getProperties()`) would
   * reopen exactly the race this exists to close: another write could land
   * between the two calls, so the ETag would no longer match the content just
   * hashed, and `If-Match` would then overwrite that intervening write instead
   * of rejecting it.
   */
  private async downloadWithEtag(filePath: string): Promise<{ content: Buffer; etag: string } | null> {
    const blob = this.toBlobPath(filePath);
    try {
      const resp = await this.containerFor(blob).getBlobClient(blob).download();
      const content = await streamToBuffer(resp.readableStreamBody);
      return { content, etag: resp.etag ?? '' };
    } catch (err) {
      if (isNotFound(err)) { recordBlobError(err, 'readFile', blob, 'warn'); return null; }
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'azure-blob-backend', level: 'error',
        message: `readFile failed: ${blob}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw wrapBlobError(err, 'readFile', blob);
    }
  }

  /**
   * t/4201 (p/775#31)/t/4191: versions by content's git blob SHA (gitBlobSha)
   * rather than the empty string this backend used to return — returning `''`
   * meant no `If-Match`, so every save on a local web server backed by Blob hit
   * the route's mandatory-428 rule. When `opts.baseSha` is supplied, enforcement
   * is now atomic: one `download()` (see `downloadWithEtag`) supplies both the
   * hash to check and the ETag the upload is conditioned on, so nothing can
   * land between the check and the write.
   * - `baseSha` matches an existing blob's hash → `If-Match: <that ETag>`.
   * - `baseSha === ''` and no blob exists → `If-None-Match: '*'` (atomic
   *   "create only if absent" — a plain existence check-then-create has the
   *   same race as a plain hash check-then-write).
   * - Blob missing while a non-empty `baseSha` was supplied → conflict, not a
   *   silent create: the caller loaded real content that's since been deleted.
   * A 412 from the service (either condition) always maps to the same 409
   * `WRITE_CONFLICT` as a pre-upload hash mismatch; any other `RestError` is
   * rethrown unmapped.
   */
  /** Resolves `opts.baseSha` into the SDK's upload conditions, or throws a 409
   *  `WRITE_CONFLICT` — see the atomicity note on `writeFile` above. Returns
   *  `undefined` when no precondition was requested (unconditional write). */
  private async resolveWriteConditions(
    filePath: string, blob: string, baseSha: string | undefined,
  ): Promise<{ ifMatch?: string; ifNoneMatch?: string } | undefined> {
    if (baseSha === undefined) return undefined;
    const current = await this.downloadWithEtag(filePath);
    if (current === null) {
      if (baseSha !== '') throw writeConflictError(filePath, blob);
      return { ifNoneMatch: '*' };
    }
    if (gitBlobSha(current.content.toString('utf-8')) !== baseSha) throw writeConflictError(filePath, blob);
    return { ifMatch: current.etag };
  }

  async writeFile(filePath: string, content: string, opts?: { ref?: string; baseSha?: string }): Promise<{ version: string }> {
    const blob = this.toBlobPath(filePath);
    const conditions = await this.resolveWriteConditions(filePath, blob, opts?.baseSha);
    const data = Buffer.from(content, 'utf-8');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.uploadTimeoutMs);
    try {
      await this.containerFor(blob).getBlockBlobClient(blob).upload(data, data.byteLength, {
        blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
        abortSignal: ac.signal,
        conditions,
      });
      return { version: gitBlobSha(content) };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'azure-blob-backend', level: 'error',
          message: `writeFile timed out after ${this.uploadTimeoutMs}ms: ${blob}`,
          data: { blob, timeoutMs: this.uploadTimeoutMs, payloadBytes: data.byteLength },
        });
        throw Object.assign(new ActionableError({
          goal: 'Azure Blob writeFile',
          problem: `Blob upload timed out after ${this.uploadTimeoutMs}ms for "${blob}" (${data.byteLength} bytes)`,
          location: 'AzureBlobBackend.writeFile',
          nextSteps: [
            'Retry the save — the timeout may indicate a transient stall (cold replica)',
            'If the problem persists, check Azure Blob service health',
          ],
        }), { statusCode: 503 });
      }
      if (isPreconditionFailed(err)) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'azure-blob-backend', level: 'warn',
          message: `writeFile precondition failed (412), reporting as a conflict: ${blob}`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        throw writeConflictError(filePath, blob);
      }
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'azure-blob-backend', level: 'error',
        message: `writeFile failed: ${blob}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw wrapBlobError(err, 'writeFile', blob);
    } finally {
      clearTimeout(timer);
    }
  }

  async writeBinaryFile(filePath: string, content: Buffer, _opts?: { ref?: string }): Promise<void> {
    const blob = this.toBlobPath(filePath);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.uploadTimeoutMs);
    try {
      await this.containerFor(blob).getBlockBlobClient(blob).upload(content, content.byteLength, {
        blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
        abortSignal: ac.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'azure-blob-backend', level: 'error',
          message: `writeBinaryFile timed out after ${this.uploadTimeoutMs}ms: ${blob}`,
          data: { blob, timeoutMs: this.uploadTimeoutMs, payloadBytes: content.byteLength },
        });
        throw Object.assign(new ActionableError({
          goal: 'Azure Blob writeBinaryFile',
          problem: `Blob upload timed out after ${this.uploadTimeoutMs}ms for "${blob}" (${content.byteLength} bytes)`,
          location: 'AzureBlobBackend.writeBinaryFile',
          nextSteps: [
            'Retry the save — the timeout may indicate a transient stall (cold replica)',
            'If the problem persists, check Azure Blob service health',
          ],
        }), { statusCode: 503 });
      }
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'azure-blob-backend', level: 'error',
        message: `writeBinaryFile failed: ${blob}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw wrapBlobError(err, 'writeBinaryFile', blob);
    } finally {
      clearTimeout(timer);
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    const blob = this.toBlobPath(filePath);
    try {
      await this.containerFor(blob).getBlobClient(blob).delete();
    } catch (err) {
      if (isNotFound(err)) { recordBlobError(err, 'deleteFile', blob, 'warn'); return; } // no-op on missing
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'azure-blob-backend', level: 'error',
        message: `deleteFile failed: ${blob}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw wrapBlobError(err, 'deleteFile', blob);
    }
  }

  async fileExists(filePath: string): Promise<boolean> {
    const blob = this.toBlobPath(filePath);
    try {
      return await this.containerFor(blob).getBlobClient(blob).exists();
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'azure-blob-backend', level: 'error',
        message: `fileExists failed: ${blob}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw wrapBlobError(err, 'fileExists', blob);
    }
  }

  async listDirectory(dirPath: string, _opts?: { ref?: string }): Promise<string[]> {
    const dir = this.toBlobPath(dirPath);
    const prefix = dir === '' ? '' : dir + '/';
    const names = new Set<string>();
    try {
      const iter = this.containerFor(prefix || dir).listBlobsByHierarchy('/', { prefix });
      for await (const item of iter) {
        // Blobs: item.name = "<prefix><file>". Virtual dirs: item.name = "<prefix><sub>/".
        const seg = item.name.slice(prefix.length).replace(/\/$/, '');
        if (seg) names.add(seg);
      }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'azure-blob-backend', level: 'error',
        message: `listDirectory failed: ${dir}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw wrapBlobError(err, 'listDirectory', dir);
    }
    return [...names];
  }
}
