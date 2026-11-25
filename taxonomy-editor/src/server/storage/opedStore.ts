// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Op-ed set persistence — atomic finalize, partial-set semantics, .inprogress tier.
 * Parallel to debateStore.ts (ADR-007, t/2572). Re-exported from fileIO.ts.
 *
 * Visibility contract: .inprogress blobs are NEVER surfaced by listOpedSets or
 * loadOpedSet. Only finalizeOpedSet promotes a set to the visible final state.
 * Orphaned .inprogress blobs are swept once per user per server lifetime.
 *
 * t/665 (t/500): a VERIFIED anonymous visitor (storage id `anon-<uuid v4>`, from the signed anon_session_id
 * cookie, t/664) stores op-eds at `anon-oped/<uuid>/` in the user-content container (t/500#36), never under
 * `users/`. Each anonymous set carries a last-access stamp; a set not opened by its owner for
 * getAnonOpEdRetentionMs() (default 24 h) is removed from the app: the owner's read returns null and deletes it,
 * list drops and deletes it, and the periodic sweep deletes unread ones (t/500#47, #49). Only the owner's own read
 * or write refreshes the stamp, and at most hourly. An anonymous request WITHOUT a verified key (`_local`) is
 * refused as before: it never reaches `anon-oped/`, `oped-sets/` or `users/`. Signed-in users are unchanged.
 */

import path from 'path';
import { resolveDataPath } from '../config.js';
import type { OpEdSet, OpEdSetSummary, PovKey } from '../../../../lib/oped/types.js';
import { parseOpEdSet } from '../../../../lib/oped/schemas.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { log } from '../logger.js';
import { getConfig } from '../runtimeConfig.js';
import { getStorageUserId, isAnonymousUser } from '../security/userContext.js';
import { checkQuota, type QuotaCheckResult } from '../security/quotas.js';
import { getUserContentBackend, assertSafeId } from './fileIO.js';
import { unpublishOpedShare } from './opedShareStore.js';

// ── t/665: anonymous op-ed location, retention and stamps ──

/** The root for anonymous op-ed sets in the user-content container (t/500#36). No signed-in path starts with it. */
export const ANON_OPED_ROOT = 'anon-oped';
/** A full uuid v4, as crypto.randomUUID() makes it: the only directory names the sweep or the resolver accepts. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_ANON_OPED_RETENTION_MS = 24 * 60 * 60 * 1000;
/** The stamp is rewritten at most this often, so a busy owner doesn't rewrite the set blob on every read. */
export const ANON_OPED_STAMP_INTERVAL_MS = 60 * 60 * 1000;
/** The sweep visits at most this many visitor directories per run (t/665). */
export const ANON_OPED_SWEEP_MAX_DIRS = 200;
const DEFAULT_ANON_OPED_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** The stamp field, in an anonymous set blob and its `_index.json` entry. Never returned to the client. */
const STAMP_FIELD = 'last_accessed_at';

/** How long an anonymous set lives after its owner last opened it: runtime config `sessions.anonOpEdRetentionMs`
 *  (t/500#12, #49; in RuntimeConfig since c975c2cd1), default 24 h. A missing or non-positive value uses the default,
 *  with a WARN for a bad value. */
export function getAnonOpEdRetentionMs(): number {
  const raw: unknown = getConfig().sessions?.anonOpEdRetentionMs;
  if (raw === undefined) return DEFAULT_ANON_OPED_RETENTION_MS;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  log.server.warn({ value: raw }, 'runtime config sessions.anonOpEdRetentionMs is not a positive number; using the 24 h default (t/665)');
  return DEFAULT_ANON_OPED_RETENTION_MS;
}

/** The verified anonymous visitor's uuid, or null. Verified means anonymous with a storage id `anon-<uuid v4>`; the
 *  cookie signature is checked upstream (t/664), and an unsigned or forged cookie arrives here as `_local`. */
function verifiedAnonUuid(): string | null {
  if (!isAnonymousUser()) return null;
  const id = getStorageUserId();
  if (!id.startsWith('anon-')) return null;
  const uuid = id.slice('anon-'.length);
  return UUID_V4_RE.test(uuid) ? uuid : null;
}

/** Where the current request's op-ed sets live, or null when it may not have any (anonymous without a verified key). */
type OpedOwner = { dir: string; anon: boolean };
function resolveOpedOwner(): OpedOwner | null {
  if (isAnonymousUser()) {
    const uuid = verifiedAnonUuid();
    return uuid ? { dir: resolveDataPath(`${ANON_OPED_ROOT}/${uuid}`), anon: true } : null;
  }
  return { dir: getOpedSetsDir(), anon: false };
}

function stampOf(rec: unknown): number {
  const r = rec as Record<string, unknown> | null;
  for (const k of [STAMP_FIELD, 'updated_at', 'created_at']) {
    const t = typeof r?.[k] === 'string' ? Date.parse(r[k] as string) : NaN;
    if (Number.isFinite(t)) return t;
  }
  return 0; // no usable stamp: treat as long expired, so it can't live forever
}

function isExpired(rec: unknown, now: number): boolean {
  return now - stampOf(rec) > getAnonOpEdRetentionMs();
}

function withoutStamp<T>(rec: T): T {
  if (!rec || typeof rec !== 'object') return rec;
  const { [STAMP_FIELD]: _drop, ...rest } = rec as Record<string, unknown>;
  return rest as T;
}

// ── Dir helpers ──

function getOpedSetsDir(): string {
  const userId = getStorageUserId();
  if (userId === '_local') return resolveDataPath('oped-sets');
  return resolveDataPath(`users/${userId}/oped-sets`);
}

const OPED_INDEX_FILE = '_index.json';
const setFile = (dir: string, setId: string) => path.join(dir, `oped-set-${setId}.json`);
const inProgressFile = (dir: string, setId: string) => path.join(dir, `oped-set-${setId}.json.inprogress`);

// ── Index helpers (keyed by directory, so the sweep can use them outside a request) ──

async function readOpedSetIndex(dir: string): Promise<OpEdSetSummary[] | null> {
  const raw = await getUserContentBackend().readFile(path.join(dir, OPED_INDEX_FILE));
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { /* telemetry — silent by design */ return null; }
}

async function writeOpedSetIndex(dir: string, entries: OpEdSetSummary[]): Promise<void> {
  await getUserContentBackend().writeFile(path.join(dir, OPED_INDEX_FILE), JSON.stringify(entries, null, 2));
}

async function upsertOpedSetIndex(dir: string, summary: OpEdSetSummary): Promise<void> {
  const entries = (await readOpedSetIndex(dir)) ?? [];
  const idx = entries.findIndex(e => e.set_id === summary.set_id);
  if (idx >= 0) entries[idx] = summary;
  else entries.push(summary);
  await writeOpedSetIndex(dir, entries);
}

async function removeFromOpedSetIndex(dir: string, setId: string): Promise<void> {
  const entries = await readOpedSetIndex(dir);
  if (!entries) return;
  const filtered = entries.filter(e => e.set_id !== setId);
  if (filtered.length !== entries.length) await writeOpedSetIndex(dir, filtered);
}

/** t/665: remove an expired anonymous set: the set blob, its .inprogress blob and its index entry. Never throws. */
async function deleteExpiredAnonSet(dir: string, setId: string, reason: 'read' | 'list' | 'sweep'): Promise<void> {
  const backend = getUserContentBackend();
  await unpublishOpedShare(setId).catch((err: unknown) => {
    log.server.warn({ err: String(err), setId }, 'expired anonymous op-ed: share revocation failed (best-effort; t/665)');
  });
  await backend.deleteFile(setFile(dir, setId)).catch((err: unknown) => {
    log.server.warn({ err: String(err), setId, reason }, 'expired anonymous op-ed: set delete failed; the next read or sweep retries (t/665)');
  });
  await backend.deleteFile(inProgressFile(dir, setId)).catch(() => { /* best-effort — .inprogress may not exist */ });
  log.server.info({ setId, reason }, 'anonymous op-ed set removed: not opened by its owner within the retention window (t/665)');
}

/** t/665: refresh the stamp in the set blob and its index entry, at most hourly. Owner reads and writes only. */
async function refreshAnonStamp(dir: string, setId: string, setDoc: Record<string, unknown>, now: number): Promise<void> {
  if (now - stampOf(setDoc) < ANON_OPED_STAMP_INTERVAL_MS) return;
  const stamp = new Date(now).toISOString();
  try {
    await getUserContentBackend().writeFile(setFile(dir, setId), JSON.stringify({ ...setDoc, [STAMP_FIELD]: stamp }, null, 2));
    const entries = (await readOpedSetIndex(dir)) ?? [];
    const idx = entries.findIndex(e => e.set_id === setId);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], [STAMP_FIELD]: stamp } as OpEdSetSummary;
      await writeOpedSetIndex(dir, entries);
    }
  } catch (err: unknown) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'oped-store', level: 'warn',
      message: 'anonymous op-ed last-access stamp could not be written; the set keeps its older stamp (t/665)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

// ── Startup orphan sweep ──

// Tracks which users have been swept this server lifetime — ensures once-only semantics.
const _sweptUsers = new Set<string>();

/** Sweep all orphaned .inprogress blobs for the current user. Best-effort: errors logged,
 *  never thrown. Runs once per user per server lifetime (guarded by _sweptUsers). */
async function sweepOrphanedOpedSetInProgress(dir: string): Promise<void> {
  const userId = getStorageUserId();
  if (_sweptUsers.has(userId)) return;
  _sweptUsers.add(userId);
  const backend = getUserContentBackend();
  try {
    const files = await backend.listDirectory(dir);
    const orphans = files.filter(f => f.endsWith('.inprogress'));
    for (const f of orphans) {
      try {
        await backend.deleteFile(path.join(dir, f));
        log.server.info({ file: f }, 'Swept orphaned oped-set .inprogress blob');
      } catch (err) {
        log.server.warn({ err, file: f }, 'Failed to sweep orphaned oped-set .inprogress blob (best-effort)');
      }
    }
  } catch (err) {
    log.server.warn({ err }, 'Failed to list oped-sets dir for orphan sweep (best-effort)');
  }
}

// ── Public API ──

/** Oped-set quota status for the current user — exact count + cap.
 *  Shared by finalizeOpedSet and the GET /api/oped-sets/quota-status pre-check so
 *  they can never diverge (Shared Utility Rule, mirrors getDebatesQuotaStatus). */
export async function getOpedSetsQuotaStatus(): Promise<QuotaCheckResult> {
  const owner = resolveOpedOwner();
  const files = owner ? (await getUserContentBackend().listDirectory(owner.dir))
    .filter(f => f.startsWith('oped-set-') && f.endsWith('.json')) : [];
  return checkQuota('opeds', files.length);
}

/** List oped-sets for the current user — reads _index.json only, never individual docs.
 *  .inprogress blobs are invisible. Triggers orphan sweep on first call per user.
 *  t/665: for an anonymous visitor, expired entries are dropped and deleted; a list never refreshes a stamp. */
export async function listOpedSets(): Promise<OpEdSetSummary[]> {
  const owner = resolveOpedOwner();
  if (!owner) return [];
  void sweepOrphanedOpedSetInProgress(owner.dir);
  const entries = (await readOpedSetIndex(owner.dir)) ?? [];
  if (!owner.anon) return entries;
  const now = Date.now();
  const live = entries.filter(e => !isExpired(e, now));
  if (live.length !== entries.length) {
    for (const e of entries.filter(x => isExpired(x, now))) await deleteExpiredAnonSet(owner.dir, e.set_id, 'list');
    await writeOpedSetIndex(owner.dir, live).catch((err: unknown) => {
      log.server.warn({ err: String(err) }, 'anonymous op-ed index rewrite after expiry failed (best-effort; t/665)');
    });
  }
  return live.map(withoutStamp);
}

/** Load a finalized oped-set doc by setId; returns null if not found.
 *  Never surfaces .inprogress blobs.
 *  t/665: for an anonymous visitor, a set past retention returns null and is deleted now; otherwise this read (the
 *  owner's own) refreshes the stamp, at most hourly. */
export async function loadOpedSet(setId: string): Promise<unknown> {
  assertSafeId(setId, 'oped-set id');
  const owner = resolveOpedOwner();
  if (!owner) return null;
  const raw = await getUserContentBackend().readFile(setFile(owner.dir, setId));
  if (raw === null) return null;
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(raw); } catch { /* telemetry — silent by design */ return null; }
  if (!owner.anon) return doc;
  const now = Date.now();
  if (isExpired(doc, now)) {
    await deleteExpiredAnonSet(owner.dir, setId, 'read');
    await removeFromOpedSetIndex(owner.dir, setId).catch(() => { /* best-effort; list or the sweep retries */ });
    return null;
  }
  await refreshAnonStamp(owner.dir, setId, doc, now);
  return withoutStamp(doc);
}

/** Write a partial snapshot during generation. Invisible to list/load paths. */
export async function saveOpedSetInProgress(setId: string, partial: unknown): Promise<void> {
  assertSafeId(setId, 'oped-set id');
  const owner = resolveOpedOwner();
  if (!owner) return;
  await getUserContentBackend().writeFile(inProgressFile(owner.dir, setId), JSON.stringify(partial, null, 2));
}

/** Load the in-progress snapshot; returns null if not found. */
export async function loadOpedSetInProgress(setId: string): Promise<unknown> {
  assertSafeId(setId, 'oped-set id');
  const owner = resolveOpedOwner();
  if (!owner) return null;
  const raw = await getUserContentBackend().readFile(inProgressFile(owner.dir, setId));
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { /* telemetry — silent by design */ return null; }
}

/**
 * Atomic finalize: write final doc → upsert index → delete .inprogress (best-effort).
 *
 * Accepts any mix of member statuses (partial-set contract, e/91#2 condition 1).
 * Step (a) is atomic on blob — backend.writeFile either completes or fails; no
 * partial write is possible. Steps (b) and (c) are best-effort.
 * t/665: an anonymous set is stamped now (its owner's write), in the blob and its index entry.
 */
export async function finalizeOpedSet(set: OpEdSet): Promise<void> {
  assertSafeId(set.set_id, 'oped-set id');
  const owner = resolveOpedOwner();
  if (!owner) return;
  const backend = getUserContentBackend();
  const dir = owner.dir;
  const now = new Date().toISOString();

  // Quota check — only for NEW sets; re-finalizing an existing set is never blocked
  const isNew = (await backend.readFile(setFile(dir, set.set_id))) === null;
  if (isNew) {
    const q = await getOpedSetsQuotaStatus();
    if (!q.allowed) {
      throw Object.assign(new ActionableError({
        goal: 'Finalize op-ed set',
        problem: `Op-ed set quota exceeded (${q.current}/${q.limit})`,
        location: 'server/storage/opedStore.ts → finalizeOpedSet',
        nextSteps: ['Delete existing op-ed sets to free space'],
      }), { statusCode: 429, quotaInfo: q });
    }
  }

  // Validate shape before writing — rejects PS short-code pov / PascalCase grounding fields
  const validated = parseOpEdSet(set);
  const stamp = owner.anon ? { [STAMP_FIELD]: now } : {};

  // (a) Write final doc — single write, atomic on blob
  await backend.writeFile(setFile(dir, set.set_id), JSON.stringify({ ...validated, ...stamp }, null, 2));

  // (b) Upsert index
  const summary = {
    set_id: set.set_id,
    topic: set.topic,
    camps: [...new Set(set.opeds.map(m => m.pov))] as PovKey[],
    voice_count: set.opeds.length,
    created_at: set.created_at,
    updated_at: now,
    outlet: set.params.outlet,
    ...stamp,
  } as OpEdSetSummary;
  await upsertOpedSetIndex(dir, summary).catch((err) => {
    log.server.warn({ err, setId: set.set_id }, 'Oped-set index upsert failed (best-effort)');
  });

  // (c) Delete .inprogress — best-effort, never throws
  void backend.deleteFile(inProgressFile(dir, set.set_id))
    .catch((err) => { log.server.warn({ err, setId: set.set_id }, 'Oped-set .inprogress cleanup failed (best-effort)'); });
}

/** Delete a finalized oped-set + remove from index. Revokes any share first. Cleans up .inprogress if present. */
export async function deleteOpedSet(setId: string): Promise<void> {
  assertSafeId(setId, 'oped-set id');
  const owner = resolveOpedOwner();
  if (!owner) return;
  const backend = getUserContentBackend();
  const dir = owner.dir;
  await unpublishOpedShare(setId).catch((err) => {
    log.server.warn({ err, setId }, 'Oped-set share revocation failed (best-effort); continuing with delete');
  });
  await backend.deleteFile(setFile(dir, setId));
  void removeFromOpedSetIndex(dir, setId).catch((err) => {
    log.server.warn({ err, setId }, 'Oped-set index removal failed (best-effort)');
  });
  void backend.deleteFile(inProgressFile(dir, setId))
    .catch(() => { /* best-effort — .inprogress may not exist */ });
}

// ── t/665: the periodic sweep of anonymous op-ed sets nobody opens ──

/** Which visitor directories the next run starts from, so 200 per run rotates through all of them. */
let sweepCursor = 0;

/** Delete expired anonymous sets under `anon-oped/` only (never `users/`), visiting at most `maxDirs` directories whose
 *  name is a full uuid v4. Reads index stamps only and never refreshes one. Never throws. */
export async function sweepExpiredAnonOpedSets(
  opts: { now?: number; maxDirs?: number } = {},
): Promise<{ dirsScanned: number; setsDeleted: number }> {
  const now = opts.now ?? Date.now();
  const maxDirs = opts.maxDirs ?? ANON_OPED_SWEEP_MAX_DIRS;
  const backend = getUserContentBackend();
  const root = resolveDataPath(ANON_OPED_ROOT);
  let names: string[];
  try {
    names = (await backend.listDirectory(root)).filter(n => UUID_V4_RE.test(n)).sort();
  } catch (err: unknown) {
    log.server.warn({ err: String(err) }, 'anonymous op-ed sweep: could not list anon-oped/; next run retries (t/665)');
    return { dirsScanned: 0, setsDeleted: 0 };
  }
  if (names.length === 0) return { dirsScanned: 0, setsDeleted: 0 };
  const start = sweepCursor % names.length;
  const batch = [...names.slice(start), ...names.slice(0, start)].slice(0, maxDirs);
  sweepCursor = (start + batch.length) % names.length;

  let setsDeleted = 0;
  for (const uuid of batch) {
    const dir = path.join(root, uuid);
    try {
      const entries = (await readOpedSetIndex(dir)) ?? [];
      const expired = entries.filter(e => isExpired(e, now));
      if (expired.length === 0) continue;
      for (const e of expired) await deleteExpiredAnonSet(dir, e.set_id, 'sweep');
      const live = entries.filter(e => !isExpired(e, now));
      if (live.length === 0) await backend.deleteFile(path.join(dir, OPED_INDEX_FILE));
      else await writeOpedSetIndex(dir, live);
      setsDeleted += expired.length;
    } catch (err: unknown) {
      log.server.warn({ err: String(err) }, 'anonymous op-ed sweep: one visitor directory failed; continuing (t/665)');
    }
  }
  if (setsDeleted > 0) log.server.info({ dirsScanned: batch.length, setsDeleted }, 'anonymous op-ed sweep removed expired sets (t/665)');
  return { dirsScanned: batch.length, setsDeleted };
}

/** Start the periodic sweep (default hourly). Returns a stop function for shutdown. The server.ts call is
 *  TaxonomyServer's. The timer is unref'd so it never holds the process open. */
export function startAnonOpedSweep(intervalMs: number = DEFAULT_ANON_OPED_SWEEP_INTERVAL_MS): () => void {
  const timer = setInterval(() => { void sweepExpiredAnonOpedSets(); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Test-only: reset the sweep's rotation. */
export function resetAnonOpedSweepCursorForTests(): void {
  sweepCursor = 0;
}
