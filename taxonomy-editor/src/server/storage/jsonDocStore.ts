// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { BlobServiceClient, type ContainerClient, RestError } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { log } from '../logger.js';
import { userContentContainer } from './userContentContainer.js';

/**
 * JsonDocStore (t/744, for t/731): small JSON documents with ETag compare-and-swap.
 *
 * This is the generic form of the read-modify-write that `freePoolBudget.ts` keeps private: download, mutate,
 * upload on the condition that nobody wrote in between, and retry a bounded number of times when somebody did.
 * Each call is one atomic update, not a held lock, so it is safe across replicas without a lease.
 *
 * **Failure contract.** Neither method ever reports a failure as "no document". `read` returns `null` only
 * when the store answered that the document does not exist. Everything else (the store unreachable, a document
 * that is not JSON, retries used up) throws an `ActionableError` with one of the `JSON_DOC_*` codes below, and the
 * caller chooses fail-open or fail-closed.
 *
 * **Names.** A store is built with a `prefix` and refuses any name outside it, so one caller's store cannot read
 * or write another's documents or user content in the same container. Names appear in logs and errors; callers
 * must not put a user id, email or IP in them (t/731 passes a SHA-256).
 */
export interface JsonDocStore {
  /** The document and its ETag, or `null` if it does not exist. Throws on any failure. */
  read<T>(name: string): Promise<{ doc: T; etag: string } | null>;
  /**
   * Read-modify-write. `fresh` makes the starting document when none exists. `mutate` changes the document in
   * place and returns what to hand back; `skipWrite: true` returns `result` without uploading. On a lost race
   * the document is downloaded again and **`mutate` runs again**, so it must depend only on the document it is
   * given and have no side effects of its own. Throws when the retries are used up or on any failure.
   */
  rmw<T, R>(name: string, fresh: () => T, mutate: (doc: T) => { result: R; skipWrite?: boolean }): Promise<R>;
}

export const JSON_DOC_READ_FAILED = 'JSON_DOC_READ_FAILED';
export const JSON_DOC_WRITE_FAILED = 'JSON_DOC_WRITE_FAILED';
export const JSON_DOC_CORRUPT = 'JSON_DOC_CORRUPT';
export const JSON_DOC_CAS_EXHAUSTED = 'JSON_DOC_CAS_EXHAUSTED';
export const JSON_DOC_NAME_REFUSED = 'JSON_DOC_NAME_REFUSED';

const DEFAULT_MAX_CAS_RETRIES = 5;
const RETRY_JITTER_MS = 15;

export function isBlobNotFound(err: unknown): boolean {
  return err instanceof RestError ? (err.statusCode === 404 || err.code === 'BlobNotFound') : false;
}

/**
 * A lost race, in both of its shapes (t/4491): 412 for a stale ETag on an existing blob (`ifMatch`), and 409
 * `BlobAlreadyExists` when two writers race to create the same new blob (`ifNoneMatch: '*'`).
 */
export function isBlobPreconditionFailed(err: unknown): boolean {
  if (!(err instanceof RestError)) return false;
  if (err.statusCode === 412) return true;
  return err.statusCode === 409 && err.code === 'BlobAlreadyExists';
}

/** The condition an upload carries: replace exactly this version, or create only if absent. */
export type DocWriteCondition = { ifMatch: string } | { ifNoneMatch: '*' };

/** What a backing store must do. `upload` answers `'lost'` for a lost race and throws for anything else. */
interface RawDocBackend {
  download(name: string): Promise<{ found: true; body: string; etag: string } | { found: false }>;
  upload(name: string, body: string, condition: DocWriteCondition): Promise<'ok' | 'lost'>;
}

export interface JsonDocStoreOptions {
  /** Every name must start with `prefix + '/'`, for example `_system/daily-tokens`. */
  prefix: string;
  /** Attempts per `rmw` before it throws `JSON_DOC_CAS_EXHAUSTED`. Default 5. */
  maxCasRetries?: number;
}

function docError(code: string, op: string, name: string, problem: string, innerError?: unknown): ActionableError {
  return new ActionableError({
    goal: `${op === 'read' ? 'Read' : 'Update'} the JSON document "${name}"`,
    problem,
    location: `JsonDocStore.${op}`,
    nextSteps: [
      'Check that the storage account is reachable and the app identity has data access to the container',
      'Check Azure Blob service health, then retry',
    ],
    innerError,
    code,
  });
}

function errorFields(err: unknown): { name: string; message: string; stack?: string } {
  const e = err as Error;
  return { name: e?.name ?? 'Error', message: String(err), stack: e?.stack };
}

/** The compare-and-swap loop, written once and shared by the Blob and in-memory stores. */
class CasJsonDocStore implements JsonDocStore {
  private readonly prefix: string;
  private readonly maxCasRetries: number;

  constructor(private readonly raw: RawDocBackend, opts: JsonDocStoreOptions) {
    const prefix = opts.prefix.replace(/\/+$/, '');
    if (!prefix || prefix.startsWith('/') || prefix.includes('..') || prefix.includes('\\')) {
      throw docError(JSON_DOC_NAME_REFUSED, 'constructor', opts.prefix, 'The store prefix is empty or is not a plain relative path.');
    }
    this.prefix = prefix;
    this.maxCasRetries = Math.max(1, opts.maxCasRetries ?? DEFAULT_MAX_CAS_RETRIES);
  }

  private assertName(name: string, op: string): void {
    const ok = name.startsWith(`${this.prefix}/`)
      && name.length > this.prefix.length + 1
      && !name.includes('..') && !name.includes('\\') && !name.includes('\0') && !name.includes('//')
      && !name.endsWith('/');
    if (!ok) {
      throw docError(JSON_DOC_NAME_REFUSED, op, name, `The name is outside this store's prefix "${this.prefix}/" or is not a plain relative path.`);
    }
  }

  /** Download and parse. `null` only for "does not exist"; a failure or a non-JSON body throws. */
  private async load<T>(name: string, op: string): Promise<{ doc: T; etag: string } | null> {
    let current: { found: true; body: string; etag: string } | { found: false };
    try {
      current = await this.raw.download(name);
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'json-doc-store', level: 'error', message: `${op}: download failed: ${name}`, error: errorFields(err) });
      throw docError(JSON_DOC_READ_FAILED, op, name, 'The document could not be downloaded; this is a storage failure, not a missing document.', err);
    }
    if (!current.found) return null;
    try {
      return { doc: JSON.parse(current.body) as T, etag: current.etag };
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'json-doc-store', level: 'error', message: `${op}: the stored document is not JSON: ${name}`, error: errorFields(err) });
      throw docError(JSON_DOC_CORRUPT, op, name, 'The stored document is not valid JSON; it was left as it is.', err);
    }
  }

  async read<T>(name: string): Promise<{ doc: T; etag: string } | null> {
    this.assertName(name, 'read');
    return this.load<T>(name, 'read');
  }

  async rmw<T, R>(name: string, fresh: () => T, mutate: (doc: T) => { result: R; skipWrite?: boolean }): Promise<R> {
    this.assertName(name, 'rmw');
    for (let attempt = 0; attempt < this.maxCasRetries; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, Math.random() * RETRY_JITTER_MS * attempt));
      const current = await this.load<T>(name, 'rmw');
      const doc = current ? current.doc : fresh();
      const outcome = mutate(doc);
      if (outcome.skipWrite) return outcome.result;
      let written: 'ok' | 'lost';
      try {
        written = await this.raw.upload(name, JSON.stringify(doc), current ? { ifMatch: current.etag } : { ifNoneMatch: '*' });
      } catch (err) {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'json-doc-store', level: 'error', message: `rmw: upload failed: ${name}`, error: errorFields(err) });
        throw docError(JSON_DOC_WRITE_FAILED, 'rmw', name, 'The document could not be uploaded; the update was not saved.', err);
      }
      if (written === 'ok') return outcome.result;
      // Lost the race to another writer: download again and re-apply.
    }
    const exhausted = docError(JSON_DOC_CAS_EXHAUSTED, 'rmw', name,
      `Another writer changed the document on each of ${this.maxCasRetries} attempts; the update was not saved.`);
    getGlobalRecorder()?.record({ type: 'system.error', component: 'json-doc-store', level: 'error', message: `rmw: retries used up: ${name}`, error: errorFields(exhausted) });
    log.server.error({ scope: 'json-doc-store', name, attempts: this.maxCasRetries }, 'rmw: lost the race on every attempt; the update was not saved');
    throw exhausted;
  }
}

export interface BlobJsonDocStoreOptions extends JsonDocStoreOptions {
  /** For example https://<account>.blob.core.windows.net, from AZURE_STORAGE_ACCOUNT_URL. */
  accountUrl: string;
  /** Default `userContentContainer()`, the container the free-pool budget uses, so staging stays isolated. */
  container?: string;
  /** Test seam: a pre-built client (an Azurite shared-key client). */
  serviceClient?: BlobServiceClient;
}

function blobBackend(containerClient: ContainerClient): RawDocBackend {
  return {
    async download(name) {
      let body: string;
      let etag: string | undefined;
      try {
        const resp = await containerClient.getBlockBlobClient(name).download();
        const chunks: Buffer[] = [];
        for await (const chunk of resp.readableStreamBody ?? []) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array | string));
        }
        body = Buffer.concat(chunks).toString('utf-8');
        etag = resp.etag;
      } catch (err) {
        // Only "this blob does not exist" is an absent document. A 404 with any other code (ContainerNotFound:
        // the container is missing or misnamed) is a failure, or a misconfigured store would read as empty.
        const absent = err instanceof RestError && err.statusCode === 404 && err.code === 'BlobNotFound';
        if (!absent) {
          log.server.error({ scope: 'json-doc-store', name, status: (err as RestError)?.statusCode, code: (err as RestError)?.code }, 'JSON document download failed');
          throw err;
        }
        return { found: false };
      }
      if (!etag) {
        throw docError(JSON_DOC_READ_FAILED, 'read', name, 'The download succeeded but returned no ETag, so the document cannot be updated safely.');
      }
      return { found: true, body, etag };
    },
    async upload(name, body, condition) {
      try {
        await containerClient.getBlockBlobClient(name).upload(body, Buffer.byteLength(body), {
          conditions: condition,
          blobHTTPHeaders: { blobContentType: 'application/json' },
        });
        return 'ok';
      } catch (err) {
        if (!isBlobPreconditionFailed(err)) {
          log.server.error({ scope: 'json-doc-store', name, status: (err as RestError)?.statusCode, code: (err as RestError)?.code }, 'JSON document upload failed');
          throw err;
        }
        return 'lost'; // another writer got there first; the caller downloads again and retries
      }
    },
  };
}

/** The Blob-backed store: one block blob per document, in the user-content container by default. */
export class BlobJsonDocStore extends CasJsonDocStore {
  constructor(opts: BlobJsonDocStoreOptions) {
    const service = opts.serviceClient ?? new BlobServiceClient(opts.accountUrl, new DefaultAzureCredential());
    super(blobBackend(service.getContainerClient(opts.container ?? userContentContainer())), opts);
  }
}

function forcedFailure(op: 'download' | 'upload', name: string): ActionableError {
  return new ActionableError({
    goal: `Simulate a storage failure on ${op}`,
    problem: `InMemoryJsonDocStore was told to fail the next ${op} of "${name}".`,
    location: 'InMemoryJsonDocStore.forceFailures',
    nextSteps: ['This is a test hook; clear it with forceFailures(op, 0)'],
  });
}

/**
 * The in-memory twin, with the same contract, for non-hosted runs and tests. It holds each document as its
 * serialized text, so a caller never shares an object with the store, as with Blob.
 *
 * Test hooks: `forceConflicts(n)` makes the next `n` uploads lose the race without writing (Blob's 412);
 * `forceFailures(op, n)` makes the next `n` downloads or uploads throw as a storage failure would.
 */
export class InMemoryJsonDocStore extends CasJsonDocStore {
  private readonly docs: Map<string, { body: string; etag: string }>;
  private readonly pending: { conflicts: number; download: number; upload: number };

  constructor(opts: JsonDocStoreOptions) {
    const docs = new Map<string, { body: string; etag: string }>();
    const pending = { conflicts: 0, download: 0, upload: 0 };
    let version = 0;
    super({
      async download(name) {
        if (pending.download > 0) { pending.download--; throw forcedFailure('download', name); }
        const held = docs.get(name);
        return held ? { found: true, ...held } : { found: false };
      },
      async upload(name, body, condition) {
        if (pending.upload > 0) { pending.upload--; throw forcedFailure('upload', name); }
        if (pending.conflicts > 0) { pending.conflicts--; return 'lost'; }
        const held = docs.get(name);
        const matches = 'ifMatch' in condition ? held?.etag === condition.ifMatch : held === undefined;
        if (!matches) return 'lost';
        docs.set(name, { body, etag: `"mem-${++version}"` });
        return 'ok';
      },
    }, opts);
    this.docs = docs;
    this.pending = pending;
  }

  /** The next `times` uploads lose the race and write nothing. */
  forceConflicts(times: number): void { this.pending.conflicts = times; }

  /** The next `times` downloads or uploads throw. */
  forceFailures(op: 'download' | 'upload', times: number): void { this.pending[op] = times; }

  /** Test helper: put raw text under a name, bypassing JSON, to model a corrupt document. */
  _setRawForTest(name: string, body: string): void { this.docs.set(name, { body, etag: '"mem-raw"' }); }

  /** Test helper: how many documents are held. */
  _sizeForTest(): number { return this.docs.size; }
}

/**
 * The store for this process: Blob when `AZURE_STORAGE_ACCOUNT_URL` is set, otherwise in memory with a WARN.
 * The in-memory store is per process and lost on restart, so the caller decides whether that is acceptable for
 * a hosted run (`kind` says which one was built).
 */
export function createJsonDocStore(
  opts: JsonDocStoreOptions, env: NodeJS.ProcessEnv = process.env,
): { store: JsonDocStore; kind: 'azure-blob' | 'memory' } {
  const accountUrl = env.AZURE_STORAGE_ACCOUNT_URL?.trim();
  if (accountUrl) return { store: new BlobJsonDocStore({ ...opts, accountUrl }), kind: 'azure-blob' };
  log.server.warn({ scope: 'json-doc-store', prefix: opts.prefix, reason: 'AZURE_STORAGE_ACCOUNT_URL unset' },
    'JSON document store is in memory: documents are per process and lost on restart');
  return { store: new InMemoryJsonDocStore(opts), kind: 'memory' };
}
