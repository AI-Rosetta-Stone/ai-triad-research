// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Replica-safe (t/4177): the in-memory cache re-reads the shared file at most ALLOWLIST_CACHE_TTL_MS
// after its last load, so a revocation made on one replica takes effect on every replica within the
// TTL. (This replaces the single-replica cache marker the scale guard used to block maxReplicas > 1.)

// t/3497 (t/3495 epic — admin-managed shared Gemini key): storage for the admin
// Gemini allowlist. Persists to <stateRoot>/admin/admin-allowlist.json — the
// class-A WRITABLE state root (config.ts getStateRoot()), same family as
// feature-flags.json / runtimeConfig / the key store, via raw `fs` (the
// documented state-root exception to the StorageBackend-for-persistence rule;
// see featureFlags.ts).
//
// MULTI-REPLICA (t/4177; was a single-replica assumption, t/3497#2-4): this is an ACL, so cache
// staleness is a security gap — a removed user keeps access on a replica whose cache predates the
// removal. The cache is therefore bounded by a TTL (the featureFlags.ts pattern): the writing
// replica updates its own cache immediately, and every other replica re-reads within
// ALLOWLIST_CACHE_TTL_MS. Prod's state root is the shared Azure Files mount, so all replicas read
// the same file. The revocation window across replicas is the TTL — keep it short.

import fs from 'fs';
import path from 'path';
import { getStateRoot } from '../config.js';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import type { AllowlistEntry } from '../../../../lib/allowlist/types.js';

interface AllowlistFile {
  version: 1;
  entries: AllowlistEntry[];
}

function allowlistPath(): string {
  return path.join(getStateRoot(), 'admin', 'admin-allowlist.json');
}

/**
 * Read admin-allowlist.json fresh (no cache). Used both to populate the cache
 * and, on the write path, as the read-modify-write base.
 * `forWrite`: distinguishes the two very different failure semantics —
 *   - read path (forWrite=false): fail-CLOSED to `[]` on ANY error (missing,
 *     corrupt, unreadable) — SO cond 1. Denying access safely is always correct.
 *   - write path (forWrite=true): ENOENT is legitimately "no file yet" (safe to
 *     start from `[]` — there is nothing on disk to lose). A parse/permission
 *     error is NOT safe to treat as `[]` here — merging a mutation onto `[]` and
 *     persisting it would silently truncate a real, unreadable-right-now
 *     allowlist to just the one entry being added. So `forWrite` re-throws on
 *     any non-ENOENT error instead, and the caller aborts the write.
 */
function readEntries(forWrite: boolean): AllowlistEntry[] {
  const p = allowlistPath();
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const data = JSON.parse(raw) as Partial<AllowlistFile>;
    if (!Array.isArray(data.entries)) throw new Error('admin-allowlist.json: entries is not an array');
    return data.entries;
  } catch (err) {
    if (forWrite && (err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (!forWrite) {
      log.server.warn({ err, path: p, cause: 'admin-allowlist-unreadable' },
        'admin allowlist file unreadable — failing CLOSED to an empty allowlist (t/3497)');
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'allowlist-store', level: 'warn',
        message: 'Admin allowlist file unreadable — failing closed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return [];
    }
    throw err;
  }
}

/** Cross-replica revocation window (t/4177): every replica re-reads the shared file this often. */
export const ALLOWLIST_CACHE_TTL_MS = 30_000;

let _cache: AllowlistEntry[] | null = null;
let _cacheLoadedAt = 0;

function getCached(): AllowlistEntry[] {
  if (_cache === null || Date.now() - _cacheLoadedAt > ALLOWLIST_CACHE_TTL_MS) {
    _cache = readEntries(false);
    _cacheLoadedAt = Date.now();
  }
  return _cache;
}

/** All allowlist entries. Fail-CLOSED: `[]` if the file is missing, corrupt, or unreadable. */
export function getEntries(): AllowlistEntry[] {
  return getCached();
}

/** Whether `userId` is allowlisted. Keyed on `userId` only — never email (SO cond 4). */
export function isAllowlisted(userId: string): boolean {
  return getCached().some(e => e.userId === userId);
}

function persist(entries: AllowlistEntry[]): void {
  const p = allowlistPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries } satisfies AllowlistFile, null, 2));
  fs.renameSync(tmp, p);
  _cache = entries; // invalidate: the in-process cache now reflects the write
  _cacheLoadedAt = Date.now();
}

/** Upsert by `userId` (idempotent — a repeat add replaces the existing entry, not a duplicate). */
export async function addEntry(entry: AllowlistEntry): Promise<void> {
  const entries = readEntries(true).filter(e => e.userId !== entry.userId);
  entries.push(entry);
  persist(entries);
}

/** Idempotent: a no-op (no write, cache untouched) if `userId` isn't present. */
export async function removeEntry(userId: string): Promise<void> {
  const entries = readEntries(true);
  if (!entries.some(e => e.userId === userId)) return;
  persist(entries.filter(e => e.userId !== userId));
}

/** Test-only: reset the in-memory cache. */
export function _resetAllowlistCache(): void { _cache = null; _cacheLoadedAt = 0; }
