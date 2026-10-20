// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Persisted cache of computed snapshot content hashes, keyed by each doc's
 * current git blob SHA (t/4334#11 condition 3, t/4350).
 *
 * `nodeSourceIndex.ts`'s `computeSnapshotHash` hashes `snapshot.md` for every
 * doc with no *recorded* `content_sha256` (t/4344 spec section 1's
 * normalization is non-trivial — BOM/line-ending/provenance-header
 * stripping, Unicode NFC, per-line trailing-whitespace trim). Real-corpus
 * measurement showed this raised cold-build cost from ~0s to 2.5-3.6s
 * (t/4334#11), since it reruns on every cache invalidation regardless of
 * whether the file actually changed.
 *
 * This cache skips the (expensive) normalize-and-hash step when a doc's blob
 * SHA matches what was last recorded for it — an invalidation then only
 * hashes files that actually changed. It still requires reading the file
 * (there's no cheaper way to derive `gitBlobSha` for FilesystemBackend/
 * AzureBlobBackend, which have no server-assigned content hash of their own),
 * but the SHA-256 content hash with its multi-step normalization is the
 * expensive part this avoids re-running for unchanged files.
 */

import fs from 'fs';
import path from 'path';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { resolveStatePath } from '../config.js';
import { gitBlobSha } from './gitBlobSha.js';

export { gitBlobSha };

export type SnapshotHashCacheEntry = { blobSha: string; hash: string | null };
export type SnapshotHashCache = Record<string, SnapshotHashCacheEntry>;

function cachePath(): string {
  return resolveStatePath('cache/node-source-index-snapshot-hashes.json');
}

/** Loads the persisted cache. A missing or corrupt file degrades to an empty
 *  cache (every doc recomputes once, same as before this change existed) —
 *  never a hard failure, since this is a pure optimization. */
export function loadSnapshotHashCache(): SnapshotHashCache {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as SnapshotHashCache : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'snapshot-hash-cache', level: 'warn',
        message: 'Failed to load snapshot hash cache — recomputing every doc this build',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
    return {};
  }
}

/** Looks up a cached hash for `docId`, scoped to its *current* `blobSha` —
 *  any mismatch (content changed, or no entry yet) is a cache miss.
 *  Returns `undefined` for a miss and `null` for a cached "no hash" result
 *  (e.g. a placeholder doc, per t/4344 section 1) — the two must stay
 *  distinguishable since `null` is a legitimate cached value, not an absence. */
export function lookupCachedHash(cache: SnapshotHashCache, docId: string, blobSha: string): string | null | undefined {
  const entry = cache[docId];
  return entry && entry.blobSha === blobSha ? entry.hash : undefined;
}

/** Records a freshly computed hash in the in-memory cache (call
 *  `pruneAndSaveSnapshotHashCache` once per build to persist it). */
export function recordHash(cache: SnapshotHashCache, docId: string, blobSha: string, hash: string | null): void {
  cache[docId] = { blobSha, hash };
}

/** Persists only entries for docs still present in `liveDocIds`, dropping
 *  removed/renamed docs so the cache doesn't grow unbounded across builds. */
export function pruneAndSaveSnapshotHashCache(cache: SnapshotHashCache, liveDocIds: Iterable<string>): void {
  const live = new Set(liveDocIds);
  const pruned: SnapshotHashCache = {};
  for (const [docId, entry] of Object.entries(cache)) {
    if (live.has(docId)) pruned[docId] = entry;
  }
  const target = cachePath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(pruned), 'utf-8');
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'snapshot-hash-cache', level: 'warn',
      message: 'Failed to persist snapshot hash cache — next cold build will recompute everything',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}
