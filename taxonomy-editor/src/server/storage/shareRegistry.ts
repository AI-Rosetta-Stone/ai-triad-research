// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Owner-scoped share registry I/O (users/{id}/{inquiry,oped}-shares.json: id → shareId), shared
// by inquiryShareStore.ts and opedShareStore.ts (t/4937 follow-up, t/117).
//
// Every registry write is a compare-and-swap: read with version, apply the mutation, write with
// `baseSha` = that version. A plain read-modify-write let unpublish(A) and publish(B) by the same
// owner overlap so that publish(B) wrote back its stale snapshot `{A, B}` after unpublish wrote
// `{}` — re-adding a revoked entry that the next refresh of A then turned back into a live public
// copy. On a WRITE_CONFLICT the mutation is re-applied to a fresh read, up to
// REGISTRY_CAS_MAX_ATTEMPTS times, then an ActionableError.
//
// Atomicity comes from the backend's `baseSha` precondition: AzureBlobBackend maps it to a native
// If-Match / If-None-Match:* (atomic); FilesystemBackend serializes conditional writes per path
// in-process (t/117); GitHubAPIBackend sends the blob SHA on the Contents PUT.
//
// Like shareRevokeGuard.ts, the backend is passed in rather than imported from fileIO.js
// (fileIO → opedStore → opedShareStore would close an import cycle).

import { ActionableError } from '../../../../lib/debate/errors.js';
import { gitBlobSha } from './gitBlobSha.js';
import type { StorageBackend } from './storageBackend.js';
import { log } from '../logger.js';

export type ShareRegistry = Record<string, string>;

export const REGISTRY_CAS_MAX_ATTEMPTS = 5;

/** Version token of an absent file — `baseSha: ''` means "create only if still absent". */
const ABSENT_VERSION = '';

function parseRegistry(raw: string | null): ShareRegistry {
  if (raw === null) return {};
  try { return JSON.parse(raw) as ShareRegistry; } catch { /* telemetry — silent by design */ return {}; }
}

async function readWithVersion(backend: StorageBackend, registryPath: string): Promise<{ reg: ShareRegistry; version: string }> {
  if (backend.readFileWithVersion) {
    const snap = await backend.readFileWithVersion(registryPath);
    return snap === null
      ? { reg: {}, version: ABSENT_VERSION }
      : { reg: parseRegistry(snap.content), version: snap.version };
  }
  // Every production backend implements readFileWithVersion; all of them version by git blob
  // SHA, so hashing a plain read gives the same token.
  log.server.warn({ registryPath, backend: backend.backendName, cause: 'share-registry-no-readFileWithVersion' },
    'share registry: backend has no readFileWithVersion; deriving the version from gitBlobSha(content)');
  const raw = await backend.readFile(registryPath);
  return { reg: parseRegistry(raw), version: raw === null ? ABSENT_VERSION : gitBlobSha(raw) };
}

export async function readShareRegistry(backend: StorageBackend, registryPath: string): Promise<ShareRegistry> {
  return parseRegistry(await backend.readFile(registryPath));
}

/**
 * Compare-and-swap update. `mutate` gets a fresh copy of the registry on every attempt (it may
 * run more than once, so it must be a pure function of its input) and returns
 * `{ changed, result }`; nothing is written when `changed` is false. Retries a WRITE_CONFLICT on
 * a re-read; any other write error is rethrown as-is.
 */
export async function updateShareRegistry<T>(
  backend: StorageBackend,
  registryPath: string,
  kind: string,
  mutate: (reg: ShareRegistry) => { changed: boolean; result: T },
): Promise<T> {
  for (let attempt = 1; attempt <= REGISTRY_CAS_MAX_ATTEMPTS; attempt++) {
    const { reg, version } = await readWithVersion(backend, registryPath);
    const { changed, result } = mutate(reg);
    if (!changed) return result;
    try {
      await backend.writeFile(registryPath, JSON.stringify(reg, null, 2), { baseSha: version });
      return result;
    } catch (err) {
      if ((err as { code?: string }).code !== 'WRITE_CONFLICT') throw err;
      log.server.warn({ kind, registryPath, attempt, maxAttempts: REGISTRY_CAS_MAX_ATTEMPTS, cause: 'share-registry-write-conflict' },
        `${kind} share registry changed under a concurrent share action — re-reading and re-applying (t/117)`);
    }
  }
  throw new ActionableError({
    goal: `Update the ${kind} share registry`,
    problem: `The registry kept changing under concurrent share actions; gave up after ${REGISTRY_CAS_MAX_ATTEMPTS} conflicting writes. Nothing was changed by this request.`,
    location: `storage/shareRegistry.ts updateShareRegistry(${registryPath})`,
    nextSteps: ['Retry the share/unshare', 'If it keeps failing, check for a client stuck re-sending share requests'],
    httpStatus: 409,
    code: 'WRITE_CONFLICT',
  });
}
