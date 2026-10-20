// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Debate + chat session persistence — extracted from fileIO.ts (ADR-007).
 *
 * Read/write/list/delete for debate sessions (plus the lightweight `_index.json`
 * and the version-aware delta merge, t/1635) and chat sessions. Anonymous users
 * route through the in-memory anon store; authenticated users hit the
 * user-content backend under `users/{id}/…`. Re-exported from fileIO.ts, so the
 * public surface and the `server/fileIO.ts → …` diagnostic locations are unchanged.
 */

import path from 'path';
import { resolveDataPath } from '../config.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { safeSerialize } from '../../../../lib/debate/persistence.js';
import { applyDebateDelta } from '../../../../lib/debate/applyDebateDelta.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import type { DebateDelta, DebateSession } from '../../../../lib/debate/types.js';
import { log } from '../logger.js';
import { getStorageUserId, isAnonymousUser, getAnonymousSessionId } from '../security/userContext.js';
import { getAnonymousSessionStore } from './anonymousSessionStore.js';
import { checkQuota, type QuotaCheckResult } from '../security/quotas.js';
import { getUserContentBackend, assertSafeId } from './fileIO.js';
import type { StorageBackend } from './storageBackend.js';

function getAnonStore() {
  const store = getAnonymousSessionStore();
  const sessionId = getAnonymousSessionId();
  return store && sessionId ? { store, sessionId } : null;
}

// ── Debate sessions ──

function getDebatesDir(): string {
  const userId = getStorageUserId();
  if (userId === '_local') return resolveDataPath('debates');
  return resolveDataPath(`users/${userId}/debates`);
}

const DEBATE_INDEX_FILE = '_index.json';

/** One row of the lightweight debate index. `model`/`turn_count` are part of the schema
 *  (t/2725) — the upsert path MUST populate them or the table renders "—" for those rows
 *  while full-rebuild rows show real values (t/2892). `turn_count` is always a number
 *  (0 when no transcript) so it doubles as the schema-drift sentinel. */
type DebateIndexEntry = { id: string; title: string; created_at: string; updated_at: string; phase: string; model?: string; turn_count?: number };

/** Read the lightweight debate index (one file read).  Returns null if the index doesn't exist. */
async function readDebateIndex(): Promise<DebateIndexEntry[] | null> {
  const backend = getUserContentBackend();
  const raw = await backend.readFile(path.join(getDebatesDir(), DEBATE_INDEX_FILE));
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { /* telemetry — silent by design */ return null; }
}

/** Write the debate index to disk. */
async function writeDebateIndex(entries: DebateIndexEntry[]): Promise<void> {
  const backend = getUserContentBackend();
  await backend.writeFile(
    path.join(getDebatesDir(), DEBATE_INDEX_FILE),
    JSON.stringify(entries, null, 2),
  );
}

/** Upsert a single debate entry in the index. */
async function upsertDebateIndex(summary: DebateIndexEntry): Promise<void> {
  const entries = (await readDebateIndex()) ?? [];
  const idx = entries.findIndex(e => e.id === summary.id);
  if (idx >= 0) entries[idx] = summary;
  else entries.push(summary);
  await writeDebateIndex(entries);
}

/** Remove a debate entry from the index by ID. */
async function removeFromDebateIndex(id: string): Promise<void> {
  const entries = await readDebateIndex();
  if (!entries) return;
  const filtered = entries.filter(e => e.id !== id);
  if (filtered.length !== entries.length) await writeDebateIndex(filtered);
}

/**
 * Fast debate listing — reads a single index file instead of every debate JSON.
 * Falls back to full scan (listDebateSessions) and rebuilds the index on first call
 * or when the file count in the tree doesn't match the index (staleness check).
 */
/**
 * t/2725: a cached index whose rows predate the model/turn_count summary fields must be
 * rebuilt — the count-only staleness check below can't detect a schema ADDITION (row count
 * is unchanged), so it would keep serving fieldless rows (Turns/Model render empty).
 */
export function isDebateIndexSchemaStale(cached: unknown[]): boolean {
  // Scan EVERY row, not just cached[0] (t/2892): the upsert path historically wrote rows
  // without turn_count, so an index can be mixed — new rows have it, older upsert rows don't.
  // Key on turn_count only: it is always a number after rebuild/upsert (0 when no transcript),
  // so it never false-triggers a rebuild loop the way an optional `model` would.
  return cached.some(r => !('turn_count' in (r as Record<string, unknown>)));
}

export async function listDebateSessionsMeta(): Promise<unknown[]> {
  if (isAnonymousUser()) { const a = getAnonStore(); return a ? await a.store.listDebatesMeta(a.sessionId) : []; }
  const backend = getUserContentBackend();
  const dir = getDebatesDir();
  const cached = await readDebateIndex();
  if (cached !== null && cached.length > 0) {
    // t/2725: rebuild synchronously on schema drift so this request returns populated fields.
    if (isDebateIndexSchemaStale(cached)) return rebuildDebateIndex();
    // Lightweight staleness check: compare file count from tree with index size.
    // listDirectory() uses the in-memory repoTree — zero API calls.
    try {
      const files = (await backend.listDirectory(dir))
        .filter(f => f.endsWith('.json') && f.startsWith('debate-'));
      if (files.length === cached.length) return cached;
      // Count mismatch — rebuild in background, return stale data now for speed
      void rebuildDebateIndex().catch((err) => { log.server.warn({ err }, 'Background debate index rebuild failed'); });
      return cached;
    } catch {
      /* telemetry — silent by design */
      return cached; // tree unavailable — trust the index
    }
  }
  // Cold start: full scan to build the index
  return rebuildDebateIndex();
}

/** Full-scan rebuild of the debate index. */
async function rebuildDebateIndex(): Promise<unknown[]> {
  const summaries = await listDebateSessions();
  const typed = summaries as { id: string; title: string; created_at: string; updated_at: string; phase: string; model?: string; turn_count?: number }[];
  await writeDebateIndex(typed).catch((err) => { log.server.warn({ err }, 'Debate index write failed (best-effort)'); });
  return typed;
}

export async function listDebateSessions(): Promise<unknown[]> {
  if (isAnonymousUser()) { const a = getAnonStore(); return a ? await a.store.listDebates(a.sessionId) : []; }
  const backend = getUserContentBackend();
  const dir = getDebatesDir();
  const summaries: { id: string; title: string; created_at: string; updated_at: string; phase: string; model?: string; turn_count?: number }[] = [];

  // Scan root debates dir + cli-runs subdirectory
  const scanDirs = [dir, path.join(dir, 'cli-runs')];

  for (const scanDir of scanDirs) {
    const files = (await backend.listDirectory(scanDir))
      .filter(f => f.endsWith('.json') && (f.startsWith('debate-') || f.endsWith('-debate.json')));
    for (const f of files) {
      try {
        const rawContent = await backend.readFile(path.join(scanDir, f));
        if (rawContent === null) continue;
        const raw = JSON.parse(rawContent);
        // Normalize CLI-generated filenames ({slug}-debate.json → debate-{id}.json)
        // Move cli-runs files up to the root debates dir for consistent access
        const canonical = `debate-${raw.id}.json`;
        const canonicalPath = path.join(dir, canonical);
        const currentPath = path.join(scanDir, f);
        if (currentPath !== canonicalPath) {
          await backend.writeFile(canonicalPath, rawContent);
          await backend.deleteFile(currentPath);
        }
        const transcript = Array.isArray(raw.transcript) ? raw.transcript : [];
        summaries.push({
          id: raw.id,
          title: raw.title || raw.topic || 'Untitled',
          created_at: raw.created_at || '',
          updated_at: raw.updated_at || raw.created_at || '',
          phase: raw.phase || 'unknown',
          model: raw.debate_model,
          turn_count: transcript.filter((t: { type?: string }) => t.type === 'statement' || t.type === 'opening').length,
        });
      } catch { /* telemetry — silent by design;  skip */ }
    }
  }
  return summaries.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
}

export async function loadDebateSession(id: string): Promise<unknown> {
  assertSafeId(id, 'debate id');
  if (isAnonymousUser()) {
    const a = getAnonStore();
    const data = a ? await a.store.loadDebate(a.sessionId, id) : null;
    if (data === null) throw new ActionableError({ goal: 'Load debate session', problem: `Debate session not found: ${id}`, location: 'server/fileIO.ts → loadDebateSession (anonymous)', nextSteps: ['Verify the debate ID exists'] });
    return data;
  }
  const backend = getUserContentBackend();
  const filePath = path.join(getDebatesDir(), `debate-${id}.json`);
  const raw = await backend.readFile(filePath);
  if (raw === null) {
    log.server.info({ backendName: backend.backendName, debateId: id, blobKey: filePath, result: 'not-found' }, 'Debate session not found on backend');
    throw new ActionableError({
      goal: 'Load debate session',
      problem: `Debate session not found: ${id}`,
      location: 'server/fileIO.ts → loadDebateSession',
      nextSteps: ['Verify the debate ID exists via listDebateSessions()'],
    });
  }
  return JSON.parse(raw);
}

/** Debate quota status for the current (non-anonymous) user — the exact count +
 *  cap the save path enforces. Shared by saveDebateSession and the read-only
 *  GET /api/debates/quota-status pre-check (t/1360) so the pre-check can never
 *  diverge from enforcement (Shared Utility Rule). */
export async function getDebatesQuotaStatus(): Promise<QuotaCheckResult> {
  const files = (await getUserContentBackend().listDirectory(getDebatesDir()))
    .filter(f => f.startsWith('debate-') && f.endsWith('.json'));
  return checkQuota('debates', files.length);
}

/**
 * t/4331: layered concurrency check, same shape the delta path (t/1635)
 * established — now closed against true concurrent writes, not just a stale
 * client:
 *  1. Domain check — `opts.expectedVersion` (when supplied) against the
 *     `_saveVersion` read right here. A mismatch is the client having loaded
 *     an old version; 409 immediately, no write attempted.
 *  2. Storage check — the write is conditioned on `baseSha` from the SAME
 *     `readFileWithVersion()` read used for the domain check, so a write
 *     landing between this read and this write (a race `expectedVersion`
 *     alone can't see, since no two in-flight requests observe the same
 *     stale version through two different checks) is caught atomically by
 *     the backend's own precondition (GitHub SHA / Blob's atomic `ifMatch`,
 *     t/4191) and mapped to the identical 409.
 * `opts.expectedVersion` omitted preserves today's unconditional-overwrite
 * behavior for back-compat, logging a once-per-user WARN so renderer
 * adoption is visible (condition 3; follow-up ticket makes it mandatory once
 * the WARN count is zero for 7 days).
 */
export async function saveDebateSession(
  session: unknown, caller: string, opts?: { expectedVersion?: number; mustNotExist?: boolean },
): Promise<{ newVersion: number }> {
  const s = session as { id: string; title?: string; topic?: { final?: string; original?: string }; created_at?: string; updated_at?: string; phase?: string; _saveVersion?: number };
  assertSafeId(s.id, 'debate id');
  if (isAnonymousUser()) {
    const a = getAnonStore();
    if (a) await a.store.saveDebate(a.sessionId, session);
    return { newVersion: (s._saveVersion ?? 0) + 1 };
  }
  const backend = getUserContentBackend();
  const debatePath = path.join(getDebatesDir(), `debate-${s.id}.json`);
  const { existing, currentVersion } = await resolveVersionedWrite(backend, debatePath, s.id, 'debate', opts);
  if (existing === null) {
    const q = await getDebatesQuotaStatus();
    if (!q.allowed) {
      throw Object.assign(new ActionableError({ goal: 'Save debate session', problem: `Debate quota exceeded (${q.current}/${q.limit})`, location: 'server/fileIO.ts → saveDebateSession', nextSteps: ['Delete existing debates to free space'] }), { statusCode: 429, quotaInfo: q });
    }
  }
  const newVersion = resolveSaveVersion(session as Record<string, unknown>, currentVersion, opts !== undefined);
  const bodyToWrite = opts !== undefined ? { ...(session as object), _saveVersion: newVersion } : session;
  const { json, hadError, errorMessage } = safeSerialize(bodyToWrite, 2);
  if (hadError) {
    log.server.warn({ debateId: s.id, errorMessage }, 'Debate session serialized with sanitizing replacer — non-serializable fields stripped');
  }
  try {
    await backend.writeFile(debatePath, json, { baseSha: existing ? existing.version : '' });
  } catch (err) {
    if (isWriteConflict(err)) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'debate-store', level: 'warn',
        message: `Debate session save hit a backend WRITE_CONFLICT (concurrent write detected): ${s.id}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw debateVersionConflict(s.id, currentVersion);
    }
    throw err;
  }
  log.server.info({ caller, debateId: s.id, backendName: backend.backendName, blobKey: debatePath, bytes: json.length, writeAck: true }, 'Debate session saved');
  // Maintain the lightweight index
  void upsertDebateIndex(buildDebateIndexEntry(s.id, { ...(session as DebateSession), _saveVersion: newVersion }))
    .catch((err) => { log.server.warn({ err }, 'Debate index upsert failed (best-effort)'); });
  return { newVersion };
}

/** Build the typed 409 version-conflict error carrying the server's current
 *  `_saveVersion` (null when no stored session exists). The client maps this to
 *  a re-read + full PUT, so a missing blob self-heals on the next save. */
function debateVersionConflict(debateId: string, currentVersion: number | null): ActionableError {
  return Object.assign(new ActionableError({
    goal: 'Apply an incremental debate-save delta to the stored session',
    problem: currentVersion === null
      ? `No stored debate session found for delta apply: ${debateId}`
      : `Delta baseVersion does not match the stored _saveVersion (${currentVersion}) for debate ${debateId}`,
    location: 'server/fileIO.ts → applyDebateDeltaToStorage',
    nextSteps: ['Re-read the full session, recompute against the returned currentVersion, and retry as a full PUT.'],
  }), { statusCode: 409, code: 'version_conflict', currentVersion });
}

/** t/4331: a backend `WRITE_CONFLICT` means a write landed between our own
 *  `readFileWithVersion()` and our `writeFile({baseSha})` — a true concurrent
 *  race, not just a client holding a stale `_saveVersion`. Each call site
 *  records the detection itself (ADR-003 requires the record() call literally
 *  in the catch, not hidden behind a helper) before converting to the same
 *  typed 409 `debateVersionConflict` throws. */
function isWriteConflict(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'WRITE_CONFLICT';
}

// t/4331 condition 3: per-user, once-per-process WARN when a full-PUT save
// arrives with no expectedVersion, so adoption of the renderer change is
// visible in logs before expectedVersion is made mandatory (follow-up ticket).
const warnedMissingExpectedVersion = new Set<string>();
function warnOnceIfNoExpectedVersion(kind: string, userId: string, hasExpectedVersion: boolean): void {
  if (hasExpectedVersion || warnedMissingExpectedVersion.has(`${kind}:${userId}`)) return;
  warnedMissingExpectedVersion.add(`${kind}:${userId}`);
  log.server.warn({ kind, userId }, `${kind} save arrived with no expectedVersion — unconditional-overwrite back-compat path (t/4331)`);
}

/** t/4331: a caller that passes `opts` (`expectedVersion` or `mustNotExist`)
 *  is participating in the server-owned versioning contract — `_saveVersion`
 *  is bumped and stamped server-side regardless of what the body says. A
 *  caller that omits `opts` entirely gets today's exact back-compat
 *  behavior: whatever `_saveVersion` is already in the body is written
 *  through unchanged (the atomicity fix above still applies either way —
 *  this only controls who owns the version NUMBER, not whether the write is
 *  safe). */
function resolveSaveVersion(body: Record<string, unknown>, currentVersion: number, participatesInVersioning: boolean): number {
  if (participatesInVersioning) return currentVersion + 1;
  const bodyVersion = body._saveVersion;
  return typeof bodyVersion === 'number' ? bodyVersion : currentVersion + 1;
}

/** `StorageBackend.readFileWithVersion` is optional (test/mock backends may
 *  not implement it). When it's absent, `version` comes back `undefined` —
 *  passed straight through as `{baseSha: undefined}` on a write, which is
 *  indistinguishable from omitting `baseSha` entirely (no precondition),
 *  preserving today's unconditional-overwrite behavior rather than
 *  misreporting "must not exist" for content that's actually there. Existence
 *  itself still comes from the ordinary `readFile`, so the `baseSha: ''`
 *  (must-not-exist) case is unaffected either way. */
async function readWithVersionOrFallback(
  backend: StorageBackend, filePath: string,
): Promise<{ content: string; version: string | undefined } | null> {
  if (backend.readFileWithVersion) return backend.readFileWithVersion(filePath);
  const content = await backend.readFile(filePath);
  return content === null ? null : { content, version: undefined };
}

/**
 * t/4331 (+ TL p/799#1 cross-coordination with t/4338): shared prelude for
 * every versioned save — one `readFileWithVersion` read backing both the
 * domain check and the storage precondition (`existing.version` as `baseSha`)
 * the caller writes under. Throws the domain conflict itself; callers only
 * need the storage-level WRITE_CONFLICT mapping around their own `writeFile`.
 *
 * `opts.mustNotExist` is a genuine *create*: t/4338's inquiry persistence is
 * creating a new entity, not holding a possibly-stale version of an existing
 * one, so it must never trip the "no expectedVersion" WARN (that WARN tracks
 * un-migrated UPDATE callers, not legitimate creates) — and it conflicts if
 * the id is already taken, rather than silently overwriting it.
 */
async function resolveVersionedWrite(
  backend: StorageBackend, filePath: string, entityId: string, kind: string,
  opts?: { expectedVersion?: number; mustNotExist?: boolean },
): Promise<{ existing: { content: string; version: string | undefined } | null; currentVersion: number }> {
  const existing = await readWithVersionOrFallback(backend, filePath);
  const currentVersion = existing ? ((JSON.parse(existing.content) as { _saveVersion?: number })._saveVersion ?? 0) : 0;
  if (opts?.mustNotExist) {
    if (existing !== null) throw debateVersionConflict(entityId, currentVersion);
    return { existing, currentVersion };
  }
  warnOnceIfNoExpectedVersion(kind, getStorageUserId(), opts?.expectedVersion !== undefined);
  if (opts?.expectedVersion !== undefined && opts.expectedVersion !== currentVersion) {
    throw debateVersionConflict(entityId, existing ? currentVersion : null);
  }
  return { existing, currentVersion };
}

/**
 * Version-aware read-merge-write for an incremental debate save (t/1635).
 *
 * Reads the stored session, checks its `_saveVersion` (absent ⇒ 0) against
 * `delta.baseVersion`, and on an exact match applies the shared pure merge
 * (`applyDebateDelta`, t/1634), writes the full merged blob, and returns the
 * bumped `{ newVersion }`. On any mismatch — or when no stored session exists —
 * throws a typed 409 carrying `currentVersion` so the client falls back to a
 * full PUT. Azure Blob has no partial write: the whole merged blob is still
 * written; the win is the client→server *upload* size only.
 *
 * The current user (real, anonymous, or `_local`) is resolved from
 * AsyncLocalStorage context exactly as `saveDebateSession` does — no userId
 * param. Anonymous sessions merge-and-mirror through the same anon store, so
 * anonymous callers pay the same uplink saving (the entire point of the delta).
 */
async function applyDeltaAnon(delta: DebateDelta): Promise<{ newVersion: number }> {
  const a = getAnonStore();
  const loaded = a ? await a.store.loadDebate(a.sessionId, delta.debateId) : null;
  if (loaded === null || a === null) throw debateVersionConflict(delta.debateId, null);
  const existing = loaded as DebateSession;
  const currentVersion = existing._saveVersion ?? 0;
  if (delta.baseVersion !== currentVersion) throw debateVersionConflict(delta.debateId, currentVersion);
  const merged = applyDebateDelta(existing, delta);
  await a.store.saveDebate(a.sessionId, merged);
  return { newVersion: merged._saveVersion ?? 0 };
}

function buildDebateIndexEntry(id: string, merged: DebateSession): DebateIndexEntry {
  const m = merged as { title?: string; topic?: { final?: string; original?: string }; created_at?: string; updated_at?: string; phase?: string; debate_model?: string; transcript?: { type?: string }[] };
  // model + turn_count mirror the full-rebuild path (listDebateSessions) so upsert-written
  // rows carry the same fields — else Turns/Model render "—" for saved debates (t/2892).
  const transcript = Array.isArray(m.transcript) ? m.transcript : [];
  return {
    id,
    title: m.title || m.topic?.final || m.topic?.original || 'Untitled',
    created_at: m.created_at || '',
    updated_at: m.updated_at || m.created_at || '',
    phase: m.phase || 'unknown',
    model: m.debate_model,
    turn_count: transcript.filter(t => t.type === 'statement' || t.type === 'opening').length,
  };
}

export async function applyDebateDeltaToStorage(delta: DebateDelta): Promise<{ newVersion: number }> {
  assertSafeId(delta.debateId, 'debate id');

  if (isAnonymousUser()) return applyDeltaAnon(delta);

  const backend = getUserContentBackend();
  const debatePath = path.join(getDebatesDir(), `debate-${delta.debateId}.json`);
  // t/4331 condition 2: readFileWithVersion (not readFile) so the baseSha
  // passed to writeFile below comes from the SAME read the _saveVersion
  // business check uses — two concurrent deltas at the same baseVersion both
  // pass this compare, but only one write's baseSha can still match at write
  // time; the backend's own atomic precondition (t/4191) catches the other.
  const existingWithVersion = await readWithVersionOrFallback(backend, debatePath);
  if (existingWithVersion === null) throw debateVersionConflict(delta.debateId, null);
  const existing = JSON.parse(existingWithVersion.content) as DebateSession;
  const currentVersion = existing._saveVersion ?? 0;
  if (delta.baseVersion !== currentVersion) throw debateVersionConflict(delta.debateId, currentVersion);

  const merged = applyDebateDelta(existing, delta);
  const { json, hadError, errorMessage } = safeSerialize(merged, 2);
  if (hadError) {
    log.server.warn({ debateId: delta.debateId, errorMessage }, 'Delta-merged debate session serialized with sanitizing replacer — non-serializable fields stripped');
  }
  try {
    await backend.writeFile(debatePath, json, { baseSha: existingWithVersion.version });
  } catch (err) {
    if (isWriteConflict(err)) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'debate-store', level: 'warn',
        message: `Delta-merged debate save hit a backend WRITE_CONFLICT (concurrent write detected): ${delta.debateId}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw debateVersionConflict(delta.debateId, currentVersion);
    }
    throw err;
  }
  void upsertDebateIndex(buildDebateIndexEntry(delta.debateId, merged))
    .catch((err) => { log.server.warn({ err }, 'Debate index upsert failed (best-effort)'); });

  return { newVersion: merged._saveVersion ?? 0 };
}

export async function deleteDebateSession(id: string): Promise<void> {
  assertSafeId(id, 'debate id');
  if (isAnonymousUser()) { const a = getAnonStore(); if (a) await a.store.deleteDebate(a.sessionId, id); return; }
  const backend = getUserContentBackend();
  await backend.deleteFile(path.join(getDebatesDir(), `debate-${id}.json`));
  void removeFromDebateIndex(id).catch((err) => { log.server.warn({ err, debateId: id }, 'Debate index removal failed (best-effort)'); });
}

export async function loadDebateComments(debateId: string): Promise<unknown> {
  assertSafeId(debateId, 'debate id');
  if (isAnonymousUser()) {
    const a = getAnonStore();
    return (await a?.store.loadDebateComments(a.sessionId, debateId)) ?? { _schema_version: '1', debateId, comments: [], _saveVersion: 0 };
  }
  const backend = getUserContentBackend();
  const filePath = path.join(getDebatesDir(), `debate-${debateId}-comments.json`);
  const raw = await backend.readFile(filePath);
  if (raw === null) {
    return { _schema_version: '1', debateId, comments: [], _saveVersion: 0 };
  }
  return JSON.parse(raw);
}

/** t/4331/condition 5: `_saveVersion` is a new field on comments — absent
 *  means 0, same convention as debate/chat sessions. Layered concurrency
 *  check identical to `saveDebateSession` (domain check + atomic `baseSha`). */
export async function saveDebateComments(
  debateId: string, data: unknown, opts?: { expectedVersion?: number; mustNotExist?: boolean },
): Promise<{ newVersion: number }> {
  assertSafeId(debateId, 'debate id');
  if (isAnonymousUser()) {
    const a = getAnonStore();
    if (a) await a.store.saveDebateComments(a.sessionId, debateId, data);
    return { newVersion: ((data as { _saveVersion?: number })._saveVersion ?? 0) + 1 };
  }
  const backend = getUserContentBackend();
  const filePath = path.join(getDebatesDir(), `debate-${debateId}-comments.json`);
  const { existing, currentVersion } = await resolveVersionedWrite(backend, filePath, debateId, 'debate-comments', opts);
  const newVersion = resolveSaveVersion(data as Record<string, unknown>, currentVersion, opts !== undefined);
  const bodyToWrite = opts !== undefined ? { ...(data as object), _saveVersion: newVersion } : data;
  const json = JSON.stringify(bodyToWrite, null, 2);
  try {
    await backend.writeFile(filePath, json, { baseSha: existing ? existing.version : '' });
  } catch (err) {
    if (isWriteConflict(err)) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'debate-store', level: 'warn',
        message: `Debate comments save hit a backend WRITE_CONFLICT (concurrent write detected): ${debateId}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw debateVersionConflict(debateId, currentVersion);
    }
    throw err;
  }
  return { newVersion };
}

// ── Chat sessions ──

function getChatsDir(): string {
  const userId = getStorageUserId();
  if (userId === '_local') return resolveDataPath('chats');
  return resolveDataPath(`users/${userId}/chats`);
}

export async function listChatSessions(): Promise<unknown[]> {
  if (isAnonymousUser()) { const a = getAnonStore(); return a ? await a.store.listChats(a.sessionId) : []; }
  const backend = getUserContentBackend();
  const dir = getChatsDir();
  const files = (await backend.listDirectory(dir)).filter(f => f.startsWith('chat-') && f.endsWith('.json'));
  const summaries: { id: string; title: string; created_at: string; updated_at: string; mode: string; pover: string }[] = [];
  for (const f of files) {
    try {
      const raw = await backend.readFile(path.join(dir, f));
      if (raw === null) continue;
      const parsed = JSON.parse(raw);
      summaries.push({
        id: parsed.id,
        title: parsed.title || 'Untitled',
        created_at: parsed.created_at || '',
        updated_at: parsed.updated_at || parsed.created_at || '',
        mode: parsed.mode || '',
        pover: parsed.pover || '',
      });
    } catch { /* telemetry — silent by design;  skip */ }
  }
  return summaries.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
}

export async function loadChatSession(id: string): Promise<unknown> {
  assertSafeId(id, 'chat id');
  if (isAnonymousUser()) {
    const a = getAnonStore();
    const data = a ? await a.store.loadChat(a.sessionId, id) : null;
    if (data === null) throw new ActionableError({ goal: 'Load chat session', problem: `Chat session not found: ${id}`, location: 'server/fileIO.ts → loadChatSession (anonymous)', nextSteps: ['Verify the chat ID exists'] });
    return data;
  }
  const backend = getUserContentBackend();
  const raw = await backend.readFile(path.join(getChatsDir(), `chat-${id}.json`));
  if (raw === null) throw new ActionableError({
    goal: 'Load chat session',
    problem: `Chat session not found: ${id}`,
    location: 'server/fileIO.ts → loadChatSession',
    nextSteps: ['Verify the chat ID exists via listChatSessions()'],
  });
  return JSON.parse(raw);
}

/** t/4331: same layered concurrency check as `saveDebateSession`. */
export async function saveChatSession(session: unknown, opts?: { expectedVersion?: number; mustNotExist?: boolean }): Promise<{ newVersion: number }> {
  const s = session as { id: string; _saveVersion?: number };
  assertSafeId(s.id, 'chat id');
  if (isAnonymousUser()) {
    const a = getAnonStore();
    if (a) await a.store.saveChat(a.sessionId, session);
    return { newVersion: (s._saveVersion ?? 0) + 1 };
  }
  const backend = getUserContentBackend();
  const chatPath = path.join(getChatsDir(), `chat-${s.id}.json`);
  const { existing, currentVersion } = await resolveVersionedWrite(backend, chatPath, s.id, 'chat', opts);
  if (existing === null) {
    const files = (await backend.listDirectory(getChatsDir())).filter(f => f.startsWith('chat-') && f.endsWith('.json'));
    const q = checkQuota('chats', files.length);
    if (!q.allowed) {
      throw Object.assign(new ActionableError({ goal: 'Save chat session', problem: `Chat quota exceeded (${q.current}/${q.limit})`, location: 'server/fileIO.ts → saveChatSession', nextSteps: ['Delete existing chats to free space'] }), { statusCode: 429, quotaInfo: q });
    }
  }
  const newVersion = resolveSaveVersion(session as Record<string, unknown>, currentVersion, opts !== undefined);
  const bodyToWrite = opts !== undefined ? { ...(session as object), _saveVersion: newVersion } : session;
  const json = JSON.stringify(bodyToWrite, null, 2);
  try {
    await backend.writeFile(chatPath, json, { baseSha: existing ? existing.version : '' });
  } catch (err) {
    if (isWriteConflict(err)) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'debate-store', level: 'warn',
        message: `Chat session save hit a backend WRITE_CONFLICT (concurrent write detected): ${s.id}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw debateVersionConflict(s.id, currentVersion);
    }
    throw err;
  }
  return { newVersion };
}

export async function deleteChatSession(id: string): Promise<void> {
  assertSafeId(id, 'chat id');
  if (isAnonymousUser()) { const a = getAnonStore(); if (a) await a.store.deleteChat(a.sessionId, id); return; }
  const backend = getUserContentBackend();
  await backend.deleteFile(path.join(getChatsDir(), `chat-${id}.json`));
}
