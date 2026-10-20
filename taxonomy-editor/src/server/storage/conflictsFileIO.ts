// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Conflicts wrapper-file CRUD — extracted from fileIO.ts (ADR-007, same pattern
 * as debateStore.ts/calibrationStore.ts/overlayCommitScheduler.ts: re-exported
 * from fileIO.ts, so the public surface and `server/fileIO.ts → …` diagnostic
 * locations stay unchanged).
 *
 * Conflicts are stored in a single wrapper file (t/689 / t/693) instead of
 * ~1,244 individual {claimId}.json files (which cost 62 batched API reads to
 * list). The 5-minute response cache lives in server.ts and is invalidated by
 * the route handlers on create/write/delete — unchanged by this layer.
 */

import path from 'path';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { getCurrentUserId } from '../security/userContext.js';
import { scheduleOverlayCommit } from './overlayCommitScheduler.js';
import { getBackend, getConflictsDir, assertSafeId, readFileWithVersionOrFallback } from './fileIO.js';

const CONFLICTS_FILE = 'conflicts.json';
const CONFLICTS_SCHEMA_VERSION = '2.0';

interface ConflictsWrapper {
  _schema_version: string;
  last_modified: string;
  conflict_count: number;
  conflicts: Record<string, unknown>[];
}

function conflictsFilePath(): string {
  return path.join(getConflictsDir(), CONFLICTS_FILE);
}

function claimIdOf(entry: unknown): string | undefined {
  return (entry as { claim_id?: string })?.claim_id;
}

/** Read the conflicts wrapper, tolerating a missing or malformed file (→ empty).
 *  t/4190: version is the on-disk wrapper's own git blob SHA (empty string for
 *  a missing/malformed file — no precondition to check against, same marker
 *  convention as readFileWithVersionOrFallback). */
async function readConflictsWrapper(): Promise<{ wrapper: ConflictsWrapper; version: string }> {
  const empty: ConflictsWrapper = {
    _schema_version: CONFLICTS_SCHEMA_VERSION,
    last_modified: new Date().toISOString(),
    conflict_count: 0,
    conflicts: [],
  };
  const result = await readFileWithVersionOrFallback(conflictsFilePath());
  if (result === null) return { wrapper: empty, version: '' };
  try {
    const parsed = JSON.parse(result.content) as Partial<ConflictsWrapper>;
    const conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts as Record<string, unknown>[] : [];
    return {
      wrapper: {
        _schema_version: parsed._schema_version ?? CONFLICTS_SCHEMA_VERSION,
        last_modified: parsed.last_modified ?? empty.last_modified,
        conflict_count: conflicts.length,
        conflicts,
      },
      version: result.version,
    };
  } catch {
    /* telemetry — silent by design; treat an unreadable conflicts file as empty */
    return { wrapper: empty, version: '' };
  }
}

/** Persist the conflicts array, refreshing conflict_count + last_modified. */
async function writeConflictsWrapper(conflicts: Record<string, unknown>[], opts?: { baseSha?: string }): Promise<{ version: string }> {
  const wrapper: ConflictsWrapper = {
    _schema_version: CONFLICTS_SCHEMA_VERSION,
    last_modified: new Date().toISOString(),
    conflict_count: conflicts.length,
    conflicts,
  };
  const result = await getBackend().writeFile(conflictsFilePath(), JSON.stringify(wrapper, null, 2), opts);
  scheduleOverlayCommit(getCurrentUserId()); // t/4258/t/4277 C3: no following commit otherwise
  return result;
}

export async function readAllConflictFiles(): Promise<unknown[]> {
  return (await readConflictsWrapper()).wrapper.conflicts;
}

/** t/4190: like readAllConflictFiles, but also returns the wrapper file's
 *  version for the save route to hand back to the client as its write
 *  precondition (ETag). */
export async function readAllConflictFilesWithVersion(): Promise<{ conflicts: unknown[]; version: string }> {
  const { wrapper, version } = await readConflictsWrapper();
  return { conflicts: wrapper.conflicts, version };
}

export async function writeConflictFile(claimId: string, data: unknown, opts?: { baseSha?: string }): Promise<{ version: string }> {
  assertSafeId(claimId, 'claimId');
  const { wrapper } = await readConflictsWrapper();
  const idx = wrapper.conflicts.findIndex(c => claimIdOf(c) === claimId);
  if (idx === -1) throw new ActionableError({
    goal: 'Update conflict definition',
    problem: `Conflict not found: ${claimId}`,
    location: 'server/conflictsFileIO.ts → writeConflictFile',
    nextSteps: [
      `Verify that a conflict with claim_id "${claimId}" exists in ${CONFLICTS_FILE}`,
      'Use createConflictFile() to create a new conflict instead of writeConflictFile()',
      'Call readAllConflictFiles() to list available conflicts',
    ],
  });
  wrapper.conflicts[idx] = data as Record<string, unknown>;
  return writeConflictsWrapper(wrapper.conflicts, opts);
}

export async function createConflictFile(claimId: string, data: unknown, opts?: { baseSha?: string }): Promise<{ version: string }> {
  assertSafeId(claimId, 'claimId');
  const { wrapper } = await readConflictsWrapper();
  if (wrapper.conflicts.some(c => claimIdOf(c) === claimId)) throw new ActionableError({
    goal: 'Create conflict definition',
    problem: `Conflict already exists: ${claimId}`,
    location: 'server/conflictsFileIO.ts → createConflictFile',
    nextSteps: [
      `Use writeConflictFile() to update the existing conflict "${claimId}"`,
      'Delete the existing conflict first if you intend to replace it',
    ],
  });
  wrapper.conflicts.push(data as Record<string, unknown>);
  return writeConflictsWrapper(wrapper.conflicts, opts);
}

export async function deleteConflictFile(claimId: string): Promise<void> {
  assertSafeId(claimId, 'claimId');
  const { wrapper } = await readConflictsWrapper();
  const filtered = wrapper.conflicts.filter(c => claimIdOf(c) !== claimId);
  // No-op if the claim wasn't present (mirrors the prior delete-missing behavior).
  if (filtered.length !== wrapper.conflicts.length) {
    await writeConflictsWrapper(filtered);
  }
}
