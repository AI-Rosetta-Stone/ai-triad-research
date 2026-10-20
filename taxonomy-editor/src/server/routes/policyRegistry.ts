// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4039 (t/4034): POST /api/policy-registry/recount { ids } → RecountPolicyMembersResult
// Recounts member_count and source_povs for the given policy ids from disk, then writes
// policy_actions.json via the storage backend. The write is omitted when recounted values
// are identical to what's on disk (changed === false). Uses policy_actions.lock (t/4028)
// to serialise concurrent writes. No dirty-registry check — the write still lands correctly
// regardless of ordering (e/264#21, e/264#23, PI ruling e/264#29). The backend does NOT commit
// atomically: on the GitHub backend this write lands in the session overlay like any other
// write outside taxonomyDataSlice.save(), and is lost on restart/scale-to-zero unless
// scheduled for commit (t/4258, confirmed stale at t/4258#16) — hence the
// scheduleOverlayCommit() call below (t/4258/t/4276 C3 route half).

import path from 'path';
import fs from 'fs/promises';
import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, statusForError, codeForError } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { getTaxonomyDir, getBackend, readTaxonomyFile, readFileWithVersionOrFallback } from '../storage/fileIO.js';
import { scheduleOverlayCommit } from '../storage/overlayCommitScheduler.js';
import { isAnonymousUser, getCurrentUserId } from '../security/userContext.js';
import {
  recountPolicyMembers,
  serializePolicyRegistry,
  type PolicyRegistry,
  type PolicyPovFileData,
  type PolicyPovFile,
  type PolicyPovFiles,
  type RecountPolicyMembersResult,
} from '../../../../lib/policy/registryRecount.js';

const COMPONENT = 'policy-registry';
const LOCK_STALE_MS = 120_000; // 120 s — mirrors PS Enter-GroundingLock (t/4028, e/264#3)
const LOCK_TIMEOUT_MS = 60_000; // 60 s
const LOCK_POLL_MS = 500;

/**
 * Acquire policy_actions.lock by atomic exclusive create (mirrors PS Enter-GroundingLock, t/4028).
 * - Breaks a lock whose mtime exceeds LOCK_STALE_MS with a WARN (e/264#3).
 * - Returns { timedOut: false, onDisk: true } on success.
 * - Returns { timedOut: true, onDisk: false } when the 60 s wait expires.
 * - If the lock directory isn't accessible (ENOENT/EACCES/EROFS), warns and returns
 *   { timedOut: false, onDisk: false } — proceed without a lock file (nothing to unlink).
 */
async function acquirePolicyActionsLock(
  lockPath: string,
): Promise<{ timedOut: boolean; onDisk: boolean }> {
  const start = Date.now();
  while (true) {
    try {
      const fh = await fs.open(lockPath, 'wx'); // atomic O_CREAT|O_EXCL
      await fh.close();
      return { timedOut: false, onDisk: true };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        // Lock held — check for staleness before polling
        try {
          const stat = await fs.stat(lockPath);
          const ageMs = Date.now() - stat.mtimeMs;
          if (ageMs > LOCK_STALE_MS) {
            getGlobalRecorder()?.record({
              type: 'lifecycle', component: COMPONENT, level: 'warn',
              message: 'Breaking stale policy_actions.lock',
              data: { ageMs },
            });
            await fs.unlink(lockPath).catch(() => undefined);
            continue; // retry immediately after breaking
          }
        } catch { /* telemetry — silent by design */ }
        if (Date.now() - start >= LOCK_TIMEOUT_MS) return { timedOut: true, onDisk: false };
        await new Promise<void>((r) => setTimeout(r, LOCK_POLL_MS));
      } else if (code === 'ENOENT' || code === 'EACCES' || code === 'EROFS') {
        // Lock directory not writable (e.g. read-only data mount) — warn and proceed
        getGlobalRecorder()?.record({
          type: 'lifecycle', component: COMPONENT, level: 'warn',
          message: 'policy_actions.lock unavailable — proceeding without filesystem lock',
          data: { code, lockPath },
        });
        return { timedOut: false, onDisk: false };
      } else {
        throw err;
      }
    }
  }
}

// All four files, read in order; the PolicyPovFiles type makes a missing key a compile error (t/4034, #3050).
async function readAllPovFiles(): Promise<PolicyPovFiles> {
  const read = async (pov: PolicyPovFile): Promise<PolicyPovFileData> => (await readTaxonomyFile(pov)) as PolicyPovFileData;
  return {
    accelerationist: await read('accelerationist'),
    safetyist: await read('safetyist'),
    skeptic: await read('skeptic'),
    situations: await read('situations'),
  };
}

export function registerPolicyRegistryRoutes(router: Router, ctx: ServerCtx): void {
  const { post } = router;

  post('/api/policy-registry/recount', async (_req, res, body) => {
    if (isAnonymousUser()) { error(res, 'Sign in required', 403); return; }

    const b = (body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(b.ids) || b.ids.some((id: unknown) => typeof id !== 'string')) {
      error(res, 'ids must be an array of strings', 400);
      return;
    }
    const ids = b.ids as string[];

    // Ensure the session branch exists before any write (required for GitHub storage backend)
    try {
      await ctx.ensureSessionBranch();
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: COMPONENT, level: 'error',
        message: 'Failed to ensure session branch for policy-registry recount',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
      return;
    }

    const taxDir = getTaxonomyDir();
    const registryPath = path.join(taxDir, 'policy_actions.json');
    const lockPath = path.join(taxDir, 'policy_actions.lock');

    const { timedOut, onDisk } = await acquirePolicyActionsLock(lockPath);
    try {
      if (timedOut) {
        // Renderer ignores `updated` on refused and uses ids directly (#3022).
        // Returning [] avoids a lock-free read and fabricated zero-counts (p/528#119).
        const result: RecountPolicyMembersResult = { status: 'refused', reason: 'locked', updated: [] };
        json(res, result);
        return;
      }

      // All I/O inside the lock (e/264#11 point 1)
      const read = await readFileWithVersionOrFallback(registryPath);
      if (read === null) { error(res, 'policy_actions.json not found', 404); return; }
      const registry = JSON.parse(read.content) as PolicyRegistry;

      // Fail closed: any POV-read failure propagates to the outer catch → 500. (p/575#47)
      const povFiles = await readAllPovFiles();

      const { registry: updatedRegistry, updated: updatedItems, changed } =
        recountPolicyMembers(registry, povFiles, ids);

      // Unchanged check before any write — wins over all other checks (e/264#11 point 2)
      if (!changed) {
        const result: RecountPolicyMembersResult = { status: 'unchanged', updated: [] };
        json(res, result);
        return;
      }

      // No dirty-registry check (e/264#21, PI e/264#29) — but the write itself still needs a
      // following commit on the GitHub backend (t/4258/t/4276 C3): this is a write outside
      // taxonomyDataSlice.save(), so it lands in the session overlay with nothing to commit it
      // unless scheduled here, same as the conflicts/cruxes/edges write paths (t/4277 C3).
      await getBackend().writeFile(registryPath, serializePolicyRegistry(updatedRegistry), { baseSha: read.version });
      scheduleOverlayCommit(getCurrentUserId());
      const result: RecountPolicyMembersResult = { status: 'written', updated: updatedItems };
      json(res, result);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: COMPONENT, level: 'error',
        message: 'Failed to recount policy member counts',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, (err as Error).message, statusForError(err), err, codeForError(err));
    } finally {
      if (onDisk) await fs.unlink(lockPath).catch(() => undefined);
    }
  });
}
