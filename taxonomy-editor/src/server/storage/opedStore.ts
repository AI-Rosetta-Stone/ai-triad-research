// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Op-ed set persistence — atomic finalize, partial-set semantics, .inprogress tier.
 * Parallel to debateStore.ts (ADR-007, t/2572). Re-exported from fileIO.ts.
 *
 * Visibility contract: .inprogress blobs are NEVER surfaced by listOpedSets or
 * loadOpedSet. Only finalizeOpedSet promotes a set to the visible final state.
 * Orphaned .inprogress blobs are swept once per user per server lifetime.
 */

import path from 'path';
import { resolveDataPath } from '../config.js';
import type { OpEdSet, OpEdSetSummary, PovKey } from '../../../../lib/oped/types.js';
import { parseOpEdSet } from '../../../../lib/oped/schemas.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { log } from '../logger.js';
import { getStorageUserId, isAnonymousUser } from '../security/userContext.js';
import { checkQuota, type QuotaCheckResult } from '../security/quotas.js';
import { getUserContentBackend, assertSafeId } from './fileIO.js';
import { unpublishOpedShare } from './opedShareStore.js';

// ── Dir helpers ──

function getOpedSetsDir(): string {
  const userId = getStorageUserId();
  if (userId === '_local') return resolveDataPath('oped-sets');
  return resolveDataPath(`users/${userId}/oped-sets`);
}

const OPED_INDEX_FILE = '_index.json';

// ── Index helpers ──

async function readOpedSetIndex(): Promise<OpEdSetSummary[] | null> {
  const backend = getUserContentBackend();
  const raw = await backend.readFile(path.join(getOpedSetsDir(), OPED_INDEX_FILE));
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { /* telemetry — silent by design */ return null; }
}

async function writeOpedSetIndex(entries: OpEdSetSummary[]): Promise<void> {
  const backend = getUserContentBackend();
  await backend.writeFile(
    path.join(getOpedSetsDir(), OPED_INDEX_FILE),
    JSON.stringify(entries, null, 2),
  );
}

async function upsertOpedSetIndex(summary: OpEdSetSummary): Promise<void> {
  const entries = (await readOpedSetIndex()) ?? [];
  const idx = entries.findIndex(e => e.set_id === summary.set_id);
  if (idx >= 0) entries[idx] = summary;
  else entries.push(summary);
  await writeOpedSetIndex(entries);
}

async function removeFromOpedSetIndex(setId: string): Promise<void> {
  const entries = await readOpedSetIndex();
  if (!entries) return;
  const filtered = entries.filter(e => e.set_id !== setId);
  if (filtered.length !== entries.length) await writeOpedSetIndex(filtered);
}

// ── Startup orphan sweep ──

// Tracks which users have been swept this server lifetime — ensures once-only semantics.
const _sweptUsers = new Set<string>();

/** Sweep all orphaned .inprogress blobs for the current user. Best-effort: errors logged,
 *  not thrown. Runs once per user per server lifetime (guarded by _sweptUsers). */
async function sweepOrphanedOpedSetInProgress(): Promise<void> {
  if (isAnonymousUser()) return;
  const userId = getStorageUserId();
  if (_sweptUsers.has(userId)) return;
  _sweptUsers.add(userId);

  const backend = getUserContentBackend();
  const dir = getOpedSetsDir();
  try {
    const files = await backend.listDirectory(dir);
    const orphans = files.filter(f => f.endsWith('.inprogress'));
    await Promise.all(orphans.map(async f => {
      try {
        await backend.deleteFile(path.join(dir, f));
        log.server.info({ file: f }, 'Swept orphaned oped-set .inprogress blob');
      } catch (err) {
        log.server.warn({ err, file: f }, 'Failed to sweep orphaned oped-set .inprogress blob (best-effort)');
      }
    }));
  } catch (err) {
    log.server.warn({ err }, 'oped-set orphan sweep failed (best-effort)');
  }
}

// ── Public API ──

/** Oped-set quota status for the current (non-anonymous) user — exact count + cap.
 *  Shared by finalizeOpedSet and the GET /api/oped-sets/quota-status pre-check so
 *  they can never diverge (Shared Utility Rule, mirrors getDebatesQuotaStatus). */
export async function getOpedSetsQuotaStatus(): Promise<QuotaCheckResult> {
  const files = (await getUserContentBackend().listDirectory(getOpedSetsDir()))
    .filter(f => f.startsWith('oped-set-') && f.endsWith('.json'));
  return checkQuota('opeds', files.length);
}

/** List oped-sets for the current user — reads _index.json only, never individual docs.
 *  .inprogress blobs are invisible. Triggers orphan sweep on first call per user. */
export async function listOpedSets(): Promise<OpEdSetSummary[]> {
  if (isAnonymousUser()) return [];
  void sweepOrphanedOpedSetInProgress();
  const cached = await readOpedSetIndex();
  return cached ?? [];
}

/** Load a finalized oped-set doc by setId; returns null if not found.
 *  Never surfaces .inprogress blobs. */
export async function loadOpedSet(setId: string): Promise<unknown> {
  assertSafeId(setId, 'oped-set id');
  if (isAnonymousUser()) return null;
  const backend = getUserContentBackend();
  const raw = await backend.readFile(path.join(getOpedSetsDir(), `oped-set-${setId}.json`));
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { /* telemetry — silent by design */ return null; }
}

/** Write a partial snapshot during generation. Invisible to list/load paths. */
export async function saveOpedSetInProgress(setId: string, partial: unknown): Promise<void> {
  assertSafeId(setId, 'oped-set id');
  if (isAnonymousUser()) return;
  const backend = getUserContentBackend();
  await backend.writeFile(
    path.join(getOpedSetsDir(), `oped-set-${setId}.json.inprogress`),
    JSON.stringify(partial, null, 2),
  );
}

/** Load the in-progress snapshot; returns null if not found. */
export async function loadOpedSetInProgress(setId: string): Promise<unknown> {
  assertSafeId(setId, 'oped-set id');
  if (isAnonymousUser()) return null;
  const backend = getUserContentBackend();
  const raw = await backend.readFile(
    path.join(getOpedSetsDir(), `oped-set-${setId}.json.inprogress`),
  );
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { /* telemetry — silent by design */ return null; }
}

/**
 * Atomic finalize: write final doc → upsert index → delete .inprogress (best-effort).
 *
 * Accepts any mix of member statuses (partial-set contract, e/91#2 condition 1).
 * Step (a) is atomic on blob — backend.writeFile either completes or fails; no
 * partial write is possible. Steps (b) and (c) are best-effort.
 */
export async function finalizeOpedSet(set: OpEdSet): Promise<void> {
  assertSafeId(set.set_id, 'oped-set id');
  if (isAnonymousUser()) return;
  const backend = getUserContentBackend();
  const dir = getOpedSetsDir();
  const now = new Date().toISOString();

  // Quota check — only for NEW sets; re-finalizing an existing set is never blocked
  const isNew = (await backend.readFile(path.join(dir, `oped-set-${set.set_id}.json`))) === null;
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

  // (a) Write final doc — single write, atomic on blob
  await backend.writeFile(
    path.join(dir, `oped-set-${set.set_id}.json`),
    JSON.stringify(validated, null, 2),
  );

  // (b) Upsert index
  const summary: OpEdSetSummary = {
    set_id: set.set_id,
    topic: set.topic,
    camps: [...new Set(set.opeds.map(m => m.pov))] as PovKey[],
    voice_count: set.opeds.length,
    created_at: set.created_at,
    updated_at: now,
    outlet: set.params.outlet,
  };
  await upsertOpedSetIndex(summary).catch((err) => {
    log.server.warn({ err, setId: set.set_id }, 'Oped-set index upsert failed (best-effort)');
  });

  // (c) Delete .inprogress — best-effort, never throws
  void backend.deleteFile(path.join(dir, `oped-set-${set.set_id}.json.inprogress`))
    .catch((err) => { log.server.warn({ err, setId: set.set_id }, 'Oped-set .inprogress cleanup failed (best-effort)'); });
}

/** Delete a finalized oped-set + remove from index. Revokes any share first. Cleans up .inprogress if present. */
export async function deleteOpedSet(setId: string): Promise<void> {
  assertSafeId(setId, 'oped-set id');
  if (isAnonymousUser()) return;
  const backend = getUserContentBackend();
  const dir = getOpedSetsDir();
  await unpublishOpedShare(setId).catch((err) => {
    log.server.warn({ err, setId }, 'Oped-set share revocation failed (best-effort); continuing with delete');
  });
  await backend.deleteFile(path.join(dir, `oped-set-${setId}.json`));
  void removeFromOpedSetIndex(setId).catch((err) => {
    log.server.warn({ err, setId }, 'Oped-set index removal failed (best-effort)');
  });
  void backend.deleteFile(path.join(dir, `oped-set-${setId}.json.inprogress`))
    .catch(() => { /* best-effort — .inprogress may not exist */ });
}
