// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Debate-harvest pipeline writers — extracted from fileIO.ts (ADR-007, max-lines).
 *
 * Read-modify-write persistence for conflict records, debate-ref backlinks and
 * steelman-vulnerability text on taxonomy nodes, and verdicts on conflicts.
 * t/4184 (SO C4): a write conflict from the backend must never collapse into
 * "node not found" / false — it means another writer committed first, not
 * that the data is absent. The RMW writers below re-read (the backend evicted
 * its stale cache on the conflict, t/4184 C1) and re-apply the same mutation,
 * bounded, then rethrow once exhausted. Re-exported from fileIO.ts, so the
 * public surface and the `server/fileIO.ts → …` diagnostic locations are
 * unchanged.
 */

import path from 'path';
import { resolveDataPath } from '../config.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { POV_KEYS } from '../../../../lib/debate/types.js';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { getBackend, assertSafeId, resolveTaxonomyFilePath, getConflictsDir, readFileWithVersionOrFallback } from './fileIO.js';

const MAX_HARVEST_CONFLICT_RETRIES = 2; // + the initial attempt = 3 total

function isWriteConflict(err: unknown): boolean {
  return err instanceof ActionableError && (err as ActionableError & { code?: string }).code === 'WRITE_CONFLICT';
}

/**
 * Pure classifier for the harvest RMW writers' catch blocks below — no I/O,
 * so it can be shared without running afoul of the ADR-003 lint rule that
 * requires the actual record()/log call to stay literally in each catch
 * block (local/require-flight-recorder-in-catch forbids delegating that part).
 */
function classifyHarvestError(err: unknown, attempts: number): 'retry' | 'exhausted' | 'non-conflict' {
  if (!isWriteConflict(err)) return 'non-conflict';
  return attempts < MAX_HARVEST_CONFLICT_RETRIES ? 'retry' : 'exhausted';
}

export async function harvestCreateConflict(conflict: Record<string, unknown>): Promise<boolean> {
  const id = conflict.claim_id as string || conflict.id as string;
  if (!id) return false;
  assertSafeId(id, 'conflict id');
  await getBackend().writeFile(
    path.join(getConflictsDir(), `${id}.json`),
    JSON.stringify(conflict, null, 2),
  );
  return true;
}

export async function harvestAddDebateRef(nodeId: string, debateId: string): Promise<boolean> {
  // Find which POV file contains this node and update it
  for (const pov of [...POV_KEYS, 'situations']) {
    const filePath = await resolveTaxonomyFilePath(pov);
    let conflictAttempts = 0;
    for (;;) {
      try {
        // t/4217: readFileWithVersion is always-live (t/4203) — the plain
        // readFile() path's per-session cache can be up to 30s stale for a
        // head move this server didn't make, which is exactly the window an
        // RMW must not silently write through.
        const result = await readFileWithVersionOrFallback(filePath);
        if (result === null) break; // this pov file doesn't exist — try next pov
        const data = JSON.parse(result.content);
        const nodes = data.nodes || data;
        const node = Array.isArray(nodes) ? nodes.find((n: Record<string, unknown>) => n.id === nodeId) : null;
        if (!node) break; // not in this pov — try next pov
        if (!node.debate_refs) node.debate_refs = [];
        if (!node.debate_refs.includes(debateId)) {
          node.debate_refs.push(debateId);
          await getBackend().writeFile(filePath, JSON.stringify(data, null, 2), { baseSha: result.version });
        }
        return true;
      } catch (err) {
        const outcome = classifyHarvestError(err, conflictAttempts);
        if (outcome === 'retry') {
          conflictAttempts++;
          log.server.warn({ filePath, nodeId, debateId, attempt: conflictAttempts },
            'harvestAddDebateRef: write conflict — re-reading and retrying (not a not-found)');
          continue; // re-read: the version changed since we loaded it (another writer, a merge, a resync) — re-apply against current content
        }
        if (outcome === 'exhausted') {
          getGlobalRecorder()?.record({
            type: 'system.error', component: 'harvest', level: 'error',
            message: `harvestAddDebateRef: write conflict unresolved after ${MAX_HARVEST_CONFLICT_RETRIES + 1} attempts`,
            error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
            data: { filePath, nodeId, debateId },
          });
          throw err; // retries exhausted — never collapse into false
        }
        break; // non-conflict error on this pov file — try next pov (pre-existing silent-by-design behavior)
      }
    }
  }
  return false;
}

export async function harvestUpdateSteelman(nodeId: string, attackerPov: string, newText: string): Promise<boolean> {
  for (const pov of [...POV_KEYS, 'situations']) {
    const filePath = await resolveTaxonomyFilePath(pov);
    let conflictAttempts = 0;
    for (;;) {
      try {
        // t/4217: always-live read (t/4203) — see harvestAddDebateRef above.
        const result = await readFileWithVersionOrFallback(filePath);
        if (result === null) break; // this pov file doesn't exist — try next pov
        const data = JSON.parse(result.content);
        const nodes = data.nodes || data;
        const node = Array.isArray(nodes) ? nodes.find((n: Record<string, unknown>) => n.id === nodeId) : null;
        if (!node) break; // not in this pov — try next pov
        if (typeof node.steelman_vulnerability === 'string') {
          node.steelman_vulnerability = { [attackerPov]: newText };
        } else if (typeof node.steelman_vulnerability === 'object' && node.steelman_vulnerability !== null) {
          node.steelman_vulnerability[attackerPov] = newText;
        } else {
          node.steelman_vulnerability = { [attackerPov]: newText };
        }
        await getBackend().writeFile(filePath, JSON.stringify(data, null, 2), { baseSha: result.version });
        return true;
      } catch (err) {
        const outcome = classifyHarvestError(err, conflictAttempts);
        if (outcome === 'retry') {
          conflictAttempts++;
          log.server.warn({ filePath, nodeId, attackerPov, attempt: conflictAttempts },
            'harvestUpdateSteelman: write conflict — re-reading and retrying (not a not-found)');
          continue; // re-read: the version changed since we loaded it — re-apply against current content
        }
        if (outcome === 'exhausted') {
          getGlobalRecorder()?.record({
            type: 'system.error', component: 'harvest', level: 'error',
            message: `harvestUpdateSteelman: write conflict unresolved after ${MAX_HARVEST_CONFLICT_RETRIES + 1} attempts`,
            error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
            data: { filePath, nodeId, attackerPov },
          });
          throw err; // retries exhausted — never collapse into false
        }
        break; // non-conflict error on this pov file — try next pov (pre-existing silent-by-design behavior)
      }
    }
  }
  return false;
}

export async function harvestAddVerdict(conflictId: string, verdict: Record<string, unknown>): Promise<boolean> {
  assertSafeId(conflictId, 'conflict id'); // L4 (t/720): block path traversal before path construction
  const filePath = path.join(getConflictsDir(), `${conflictId}.json`);
  let conflictAttempts = 0;
  for (;;) {
    // t/4217: always-live read (t/4203) — see harvestAddDebateRef above.
    const result = await readFileWithVersionOrFallback(filePath);
    if (result === null) return false;
    const data = JSON.parse(result.content);
    data.verdict = verdict;
    try {
      await getBackend().writeFile(filePath, JSON.stringify(data, null, 2), { baseSha: result.version });
      return true;
    } catch (err) {
      // t/4184 (SO C4, e/300#5): RMW like harvestAddDebateRef/harvestUpdateSteelman
      // — a bare propagate on WRITE_CONFLICT would still drop the verdict if the
      // caller doesn't retry (e.g. a fire-and-forget harvest call).
      const outcome = classifyHarvestError(err, conflictAttempts);
      if (outcome === 'retry') {
        conflictAttempts++;
        log.server.warn({ filePath, conflictId, attempt: conflictAttempts },
          'harvestAddVerdict: write conflict — re-reading and retrying (not a not-found)');
        continue; // re-read: the version changed since we loaded it — re-apply against current content
      }
      if (outcome === 'exhausted') {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'harvest', level: 'error',
          message: `harvestAddVerdict: write conflict unresolved after ${MAX_HARVEST_CONFLICT_RETRIES + 1} attempts`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
          data: { filePath, conflictId },
        });
      }
      throw err; // never collapse into false
    }
  }
}

export async function harvestQueueConcept(concept: Record<string, unknown>): Promise<boolean> {
  const dir = resolveDataPath('harvests');
  await getBackend().writeFile(
    path.join(dir, `concept-${Date.now()}.json`),
    JSON.stringify(concept, null, 2),
  );
  return true;
}

export async function harvestSaveManifest(manifest: Record<string, unknown>): Promise<boolean> {
  const dir = resolveDataPath('harvests');
  await getBackend().writeFile(
    path.join(dir, `manifest-${Date.now()}.json`),
    JSON.stringify(manifest, null, 2),
  );
  return true;
}
