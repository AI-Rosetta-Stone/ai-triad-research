// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Post-write revoke guard for owner-scoped public shares (t/4937). Shared by
// inquiryShareStore.ts and opedShareStore.ts.
//
// A publish/refresh reads the owner's registry (id → shareId), then writes
// public/{kind}/{shareId}.json. An unpublish that lands inside that window removes the
// registry entry and deletes the public copy; the writer's PUT then recreates the file at a
// revoked shareId that no registry entry points to, so nobody can revoke it again.
//
// Closing it needs two halves:
//   1. unpublish removes the registry entry BEFORE deleting the public copy;
//   2. every writer re-reads the registry AFTER its public write (this helper) and, if the
//      entry no longer names its shareId, deletes what it wrote and reports not-shared.
// With (1), any writer whose PUT lands after unpublish's delete also re-reads after the
// registry change, so it sees the mismatch; any PUT that lands earlier is removed by
// unpublish's own delete.
//
// The backend is passed in rather than imported from fileIO.js: fileIO re-exports opedStore,
// which imports opedShareStore, so a runtime import here would close an import cycle.

import type { StorageBackend } from './storageBackend.js';
import { log } from '../logger.js';

export interface ShareRevokeGuardInput {
  /** 'inquiry' | 'oped' — for log context only. */
  kind: string;
  /** The owner-side id (jobId / setId) keyed in the registry. */
  id: string;
  /** The shareId this writer just wrote. */
  shareId: string;
  /** Absolute path of the public copy this writer just wrote. */
  publicPath: string;
  readRegistry: () => Promise<Record<string, string>>;
  /** The backend the public copy was written through (getUserContentBackend()). */
  backend: StorageBackend;
}

/**
 * Returns true if the registry still maps `id` → `shareId` after the public write. Otherwise
 * an unpublish (or a competing re-share) raced in: deletes the public copy this writer just
 * wrote, WARNs, and returns false so the caller reports not-shared.
 */
export async function confirmShareStillRegistered(input: ShareRevokeGuardInput): Promise<boolean> {
  const { kind, id, shareId, publicPath, readRegistry, backend } = input;
  const current = (await readRegistry())[id];
  if (current === shareId) return true;

  log.server.warn({ kind, id, shareId, registryShareId: current ?? null, cause: 'share-revoked-during-write' },
    `${kind} share was unpublished while a publish/refresh was writing — deleting the resurrected public copy and reporting not-shared (t/4937)`);
  try {
    await backend.deleteFile(publicPath);
  } catch (err) {
    // The public copy at a revoked shareId survives with no registry entry pointing to it.
    log.server.error({ err, kind, id, shareId, cause: 'share-revoked-cleanup-failed' },
      `${kind} share cleanup failed: a revoked public copy may still be readable at ${publicPath}. ` +
      'Delete it by hand from the user-content container (t/4937)');
  }
  return false;
}
