// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/3296 — fail loud on an unresolved/misprovisioned data root.
 * Checks that the 'taxonomy/' and 'dictionary/' sentinel dirs exist AND are
 * non-empty via the active storage backend. Throws ActionableError naming the
 * resolved dataRoot, how it was resolved, and the active STORAGE_MODE.
 *
 * In github-api mode, uses GitHubAPIBackend.listDirectoryStrict() (3-way
 * outcome: genuine-empty → exit; transient → retry 2×; no-creds → exit).
 * In filesystem mode, uses backend.listDirectory() (ENOENT swallowed → []
 * = definitive absent/empty, no transient confusion).
 *
 * Called at boot by server.ts (ServerAPI wires the call site).
 * Re-exported from fileIO.ts barrel.
 */

import path from 'path';
import { resolveDataPath, getDataRoot, STORAGE_MODE, CACHE_DIR } from '../config.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { getBackend } from './fileIO.js';

export async function validateDataRoot(): Promise<void> {
  const backend = getBackend();
  const sentinels = ['taxonomy', 'dictionary'] as const;

  const resolutionMethod = process.env.AI_TRIAD_DATA_ROOT
    ? 'AI_TRIAD_DATA_ROOT env var'
    : 'PROJECT_ROOT / .aitriad.json fallback';

  const hasStrict = typeof (backend as unknown as Record<string, unknown>).listDirectoryStrict === 'function';
  const strictFn = hasStrict
    ? (dir: string, opts?: { ref?: string }) =>
        (backend as unknown as { listDirectoryStrict(d: string, o?: { ref?: string }): Promise<string[]> })
          .listDirectoryStrict(dir, opts)
    : null;

  for (const sentinel of sentinels) {
    const dir = resolveDataPath(sentinel);

    if (strictFn) {
      // github-api mode: retry up to 3 attempts for transient errors
      const delayMs = parseInt(process.env.VALIDATE_DATA_ROOT_RETRY_DELAY_MS ?? '1000', 10);
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const entries = await strictFn(dir, { ref: 'main' });
          if (entries.length === 0) {
            throw new ActionableError({
              goal: 'Serve taxonomy and dictionary data',
              problem: `Data root sentinel '${sentinel}/' is present but empty. dataRoot=${getDataRoot()} (resolved via: ${resolutionMethod}), STORAGE_MODE=${STORAGE_MODE}`,
              location: 'server/storage/dataRootValidator.ts → validateDataRoot',
              nextSteps: [
                'Verify the GitHub repository contains populated taxonomy/ and dictionary/ directories on the main branch',
                'Check that AI_TRIAD_DATA_ROOT points to the correct repository if set',
                'Ensure the data repository has been cloned/populated',
              ],
            });
          }
          lastErr = undefined;
          break;
        } catch (err) {
          if (err instanceof ActionableError) throw err; // config or genuine-empty — no retry
          lastErr = err;
          getGlobalRecorder()?.record({
            type: 'system.error', component: 'file-io', level: 'warn',
            message: `validateDataRoot: transient GitHub API error on attempt ${attempt + 1}/3 for sentinel '${sentinel}/' — retrying (t/3296)`,
            data: { sentinel, attempt: attempt + 1, error: String(err) },
          });
          if (attempt < 2) {
            await new Promise<void>(r => setTimeout(r, delayMs * (attempt + 1)));
          }
        }
      }
      if (lastErr !== undefined) {
        throw new ActionableError({
          goal: 'Serve taxonomy and dictionary data',
          problem: `GitHub API is transiently unreachable after 3 attempts while validating sentinel '${sentinel}/'. dataRoot=${getDataRoot()}, STORAGE_MODE=${STORAGE_MODE}`,
          location: 'server/storage/dataRootValidator.ts → validateDataRoot',
          nextSteps: [
            'Check GitHub API status',
            'Verify GITHUB_APP_ID / GITHUB_PRIVATE_KEY / GITHUB_REPO are correct',
            'Retry startup once GitHub recovers',
          ],
        });
      }
    } else {
      // filesystem mode: ENOENT swallowed → [] = definitive absent/empty
      const entries = await backend.listDirectory(dir);
      if (entries.length === 0) {
        throw new ActionableError({
          goal: 'Serve taxonomy and dictionary data',
          problem: `Data root sentinel '${sentinel}/' is missing or empty. dataRoot=${getDataRoot()} (resolved via: ${resolutionMethod}), STORAGE_MODE=${STORAGE_MODE}`,
          location: 'server/storage/dataRootValidator.ts → validateDataRoot',
          nextSteps: [
            'Verify the data repository is cloned at the expected path',
            'Set AI_TRIAD_DATA_ROOT to the correct absolute path',
            'Check that taxonomy/ and dictionary/ directories exist in the data root',
          ],
        });
      }
    }
  }
}

/**
 * t/4298/t/4299 — on github-api mode, CACHE_DIR must never equal or sit
 * inside AI_TRIAD_DATA_ROOT (or vice versa): any process that writes the
 * data root (reconcile_grounding.py --apply, the PS cmdlets, a mount shared
 * with staging) would otherwise silently change what the github-api disk
 * cache serves, with no check against GitHub at all.
 *
 * WARN-only for now (TL, t/4299#2): making this blocking is a separate T2
 * gate-promotion, done after >=1 green prod deploy has run with the WARN
 * live and shown the predicate never fires under real traffic. Point-of-use
 * note: THIS EXEMPTION LAPSES once that promotion lands — a WARN here must
 * not be treated as acceptable indefinitely.
 *
 * No-op on filesystem mode: that mode's CACHE_DIR == AI_TRIAD_DATA_ROOT
 * alignment is intentional (t/2061) and this check must never flag it.
 */
export function validateCacheDirDisjoint(): void {
  if (STORAGE_MODE !== 'github-api') return;
  const dataRoot = process.env.AI_TRIAD_DATA_ROOT;
  if (!dataRoot) return; // nothing to collide with

  const cacheDir = path.resolve(CACHE_DIR);
  const resolvedDataRoot = path.resolve(dataRoot);
  const relFromDataRoot = path.relative(resolvedDataRoot, cacheDir);
  const cacheInsideDataRoot = relFromDataRoot === '' || (!relFromDataRoot.startsWith('..') && !path.isAbsolute(relFromDataRoot));
  const relFromCache = path.relative(cacheDir, resolvedDataRoot);
  const dataRootInsideCache = relFromCache === '' || (!relFromCache.startsWith('..') && !path.isAbsolute(relFromCache));

  if (!cacheInsideDataRoot && !dataRootInsideCache) return;

  const message = `github-api disk cache (CACHE_DIR=${cacheDir}) is not disjoint from the data root (AI_TRIAD_DATA_ROOT=${resolvedDataRoot}) — any data-root writer can change what this server serves with no check against GitHub (t/4298/t/4299)`;
  log.storage.warn({ cacheDir, dataRoot: resolvedDataRoot }, message);
  getGlobalRecorder()?.record({
    type: 'storage.fallback',
    component: 'storage',
    level: 'warn',
    message,
    data: { cacheDir, dataRoot: resolvedDataRoot },
  });
}
