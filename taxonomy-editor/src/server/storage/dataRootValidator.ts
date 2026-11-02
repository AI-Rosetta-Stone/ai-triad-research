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
 * In filesystem mode, waits (bounded) until taxonomy/, dictionary/, entities.json and
 * organizations.json are all readable, because an Azure Files mount can attach before it is
 * readable (t/4760, below).
 *
 * Called at boot by server.ts in the background, after listen (ServerAPI wires the call site).
 * Re-exported from fileIO.ts barrel.
 */

import path from 'path';
import { resolveDataPath, getDataRoot, STORAGE_MODE, CACHE_DIR } from '../config.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { getBackend, getTaxonomyDir } from './fileIO.js';

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

  if (!strictFn) {
    await waitForFilesystemData(backend, resolutionMethod);
    return;
  }

  for (const sentinel of sentinels) {
    const dir = resolveDataPath(sentinel);

    {
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
    }
  }
}

// ── Filesystem mode: wait for the data mount (t/4760) ──
// On Azure Container Apps the shared data is an Azure Files mount. A new revision can see it attached
// but not yet readable for a minute or more: reads come back empty or fail (4 rollbacks in the week
// to 11-02, t/4091#56). Filesystem listDirectory swallows ENOENT to [], so "not ready yet" and
// "genuinely empty" look the same; the only way to tell them apart is to wait. Validation runs in the
// background after the server is listening (server.ts), so /readyz reports 'warming' meanwhile and
// liveness is unaffected. The budget is provisional until r/40 has real mount-ready times.
const MOUNT_WAIT_BUDGET_MS = 180_000;
const MOUNT_RETRY_DELAY_MS = 10_000;
const SENTINEL_DIRS = ['taxonomy', 'dictionary'] as const;
// What the deploy smoke test reads, and what the failed rollbacks returned null for. Both live in
// the taxonomy directory (fileIO.readEntities / readOrganizations), not the data root.
const SENTINEL_FILES = ['entities.json', 'organizations.json'] as const;

type Backend = ReturnType<typeof getBackend>;

function envMs(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

interface MissingSentinel { name: string; err?: unknown }

/** The first sentinel that isn't readable yet (with the read error, if any), or null when all are.
 *  A read error counts as "not readable yet": the caller records it and decides whether to wait. */
async function missingFilesystemSentinel(backend: Backend): Promise<MissingSentinel | null> {
  for (const dir of SENTINEL_DIRS) {
    try {
      if ((await backend.listDirectory(resolveDataPath(dir))).length === 0) return { name: `${dir}/` };
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'data-root', level: 'warn',
        message: `validateDataRoot: listing '${dir}/' failed; treated as not-ready-yet (t/4760)`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return { name: `${dir}/`, err };
    }
  }
  for (const file of SENTINEL_FILES) {
    try {
      const raw = await backend.readFile(path.join(getTaxonomyDir(), file));
      if (!raw || raw.trim().length === 0) return { name: file };
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'data-root', level: 'warn',
        message: `validateDataRoot: reading '${file}' failed; treated as not-ready-yet (t/4760)`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return { name: file, err };
    }
  }
  return null;
}

async function waitForFilesystemData(backend: Backend, resolutionMethod: string): Promise<void> {
  const budgetMs = envMs('DATA_ROOT_MOUNT_WAIT_MS', MOUNT_WAIT_BUDGET_MS);
  const delayMs = envMs('DATA_ROOT_MOUNT_RETRY_DELAY_MS', MOUNT_RETRY_DELAY_MS);
  const start = Date.now();
  for (let attempt = 1; ; attempt++) {
    const missing = await missingFilesystemSentinel(backend);
    const elapsedMs = Date.now() - start;
    if (missing === null) {
      // Logged every boot: r/40 reads this to set the budget from data (t/4091#57 item 2).
      log.server.info({ mountReadyMs: elapsedMs, attempts: attempt }, 'Data root readable (mount ready)');
      getGlobalRecorder()?.record({
        type: 'system.info', component: 'data-root', level: 'info',
        message: `validateDataRoot: data root readable after ${elapsedMs}ms (${attempt} attempt(s)) (t/4760)`,
        data: { mountReadyMs: elapsedMs, attempts: attempt },
      });
      return;
    }
    if (elapsedMs + delayMs > budgetMs) throw filesystemMissingError(missing, elapsedMs, attempt, resolutionMethod);
    if (attempt === 1) {
      log.server.warn({ missing: missing.name, err: missing.err === undefined ? undefined : String(missing.err), budgetMs },
        'Data root not readable yet; waiting for the data mount (/readyz reports warming meanwhile)');
    }
    await new Promise<void>(r => setTimeout(r, delayMs));
  }
}

function filesystemMissingError(missing: MissingSentinel, waitedMs: number, attempts: number, resolutionMethod: string): ActionableError {
  return new ActionableError({
    goal: 'Serve taxonomy and dictionary data',
    problem: `Data root sentinel '${missing.name}' is missing or empty after waiting ${Math.round(waitedMs / 1000)}s (${attempts} attempt(s)). dataRoot=${getDataRoot()} (resolved via: ${resolutionMethod}), STORAGE_MODE=${STORAGE_MODE}`,
    innerError: missing.err,
    location: 'server/storage/dataRootValidator.ts → validateDataRoot',
    nextSteps: [
      'Verify the data repository is cloned at the expected path, or that the Azure Files mount is attached',
      'Set AI_TRIAD_DATA_ROOT to the correct absolute path',
      'Check that taxonomy/, dictionary/, entities.json and organizations.json exist in the data root',
      'If the mount is just slow, raise DATA_ROOT_MOUNT_WAIT_MS (and record the measured mount-ready time on t/4760)',
    ],
  });
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
