// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/553 (t/503 PR 4, ServerStorage p/52#50): the server.ts wiring for shared overlay state, kept out of server.ts
// (which listens on import) so it can be tested.
//   - sharedOverlayStateFromEnv: the backend's `sharedOverlayState` (store + per-user commit lock, one container), only
//     when AZURE_STORAGE_ACCOUNT_URL and AZURE_OVERLAY_STATE_CONTAINER are both set. The backend still gates the effect
//     on OVERLAY_SHARED_STATE_ENABLED; this only supplies the plumbing.
//   - startSharedOverlayDrainFromEnv: the DRAINING rollback timer (t/552) when OVERLAY_SHARED_STATE_DRAINING=1.
//   - sharedOverlayDrainHealth: the public /health field while draining: { draining, stagedEntries, usersWithEntries }
//     as COUNTS only (never user ids), bounded by a timeout so /health never waits on blob storage.

import { log } from './logger.js';
import { SharedOverlayStore } from './storage/sharedOverlayStore.js';
import type { GitHubAPIBackendConfig } from './storage/githubAPIBackend.js';
import { startSharedOverlayDrain } from './storage/overlayCommitScheduler.js';

type SharedOverlayState = NonNullable<GitHubAPIBackendConfig['sharedOverlayState']>;

export function sharedOverlayStateFromEnv(
  env: NodeJS.ProcessEnv,
  makeStore: (opts: { accountUrl: string; container: string }) => SharedOverlayStore = opts => new SharedOverlayStore(opts),
): SharedOverlayState | undefined {
  const accountUrl = env.AZURE_STORAGE_ACCOUNT_URL?.trim();
  const container = env.AZURE_OVERLAY_STATE_CONTAINER?.trim();
  if (!accountUrl || !container) {
    if (env.OVERLAY_SHARED_STATE_ENABLED === '1') {
      log.server.warn({ hasAccountUrl: !!accountUrl, hasContainer: !!container },
        'OVERLAY_SHARED_STATE_ENABLED=1 but AZURE_STORAGE_ACCOUNT_URL or AZURE_OVERLAY_STATE_CONTAINER is unset; falling back to per-replica overlay state (t/553)');
    }
    return undefined;
  }
  return { store: makeStore({ accountUrl, container }), commitLock: { accountUrl, container } };
}

/** Starts the drain timer when OVERLAY_SHARED_STATE_DRAINING=1; returns its stop, or null when not draining. */
export function startSharedOverlayDrainFromEnv(
  env: NodeJS.ProcessEnv,
  start: () => () => void = () => startSharedOverlayDrain(),
): (() => void) | null {
  if (env.OVERLAY_SHARED_STATE_DRAINING !== '1') return null;
  log.server.info({}, 'shared overlay DRAINING is on: saves are refused and staged entries drain every 30 s (t/552)');
  return start();
}

export type SharedOverlayDrainHealth =
  | { draining: boolean; stagedEntries: number; usersWithEntries: number }
  | { draining: true; unavailable: 'timeout' | 'error' }
  | null;

interface DrainStatusSource {
  getSharedOverlayDrainStatus(): Promise<{ draining: boolean; usersWithEntries: string[]; stagedEntries: number } | null>;
}

/** Null unless OVERLAY_SHARED_STATE_DRAINING=1 (so /health costs no blob reads otherwise). Never throws. */
export async function sharedOverlayDrainHealth(
  backend: DrainStatusSource | null,
  env: NodeJS.ProcessEnv,
  timeoutMs = 2_000,
): Promise<SharedOverlayDrainHealth> {
  if (!backend || env.OVERLAY_SHARED_STATE_DRAINING !== '1') return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); timer.unref?.(); });
    const status = await Promise.race([backend.getSharedOverlayDrainStatus(), timeout]);
    if (status === 'timeout') {
      log.server.warn({ timeoutMs }, 'shared overlay drain status timed out; /health reports it unavailable (t/553)');
      return { draining: true, unavailable: 'timeout' };
    }
    if (!status) return null;
    return { draining: status.draining, stagedEntries: status.stagedEntries, usersWithEntries: status.usersWithEntries.length };
  } catch (err) {
    log.server.warn({ err: (err as Error)?.name ?? 'Error' }, 'shared overlay drain status failed; /health reports it unavailable (t/553)');
    return { draining: true, unavailable: 'error' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
