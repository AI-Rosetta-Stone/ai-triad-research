// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Extracted from aiBackends.ts (t/4318) to keep that file under its max-lines budget —
// pure move, no behavior change beyond this file's own cache addition.

import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { getApiKeyForListing, getProjectRoot } from '../config.js';
import { getCurrentUserId } from '../security/userContext.js';
import { refreshAIModels as libRefreshAIModels, type RefreshResult } from '../../../../lib/electron-shared/modelDiscovery.js';
import type { RefreshModelsRequestInput } from './refreshModelsRequestSchema.js';
import { getCachedDryRun, setCachedDryRun, invalidateDryRunCache } from './refreshModelsCache.js';

export { clearRefreshAIModelsCacheForTests } from './refreshModelsCache.js';

// `ALL_BACKENDS` inside modelDiscovery.ts isn't exported, and 'ollama' needs no key (t/4162).
const KEYED_DISCOVERY_BACKENDS = ['gemini', 'claude', 'groq', 'deepseek'] as const;

// `ModelDiscoveryDeps.loadApiKey` is SYNCHRONOUS (Electron reads a local file store); the server's
// `getApiKeyForListing` is ASYNC (Key Vault in Azure mode, t/4105) — resolve every keyed backend's
// key up front, then hand the lib a sync lookup over the resolved map.
async function buildApiKeyLookup(): Promise<(backend: string) => string | null> {
  const entries = await Promise.all(
    KEYED_DISCOVERY_BACKENDS.map(async (backend) => [backend, await getApiKeyForListing(backend)] as const),
  );
  const keys = new Map<string, string | null>(entries);
  return (backend: string) => keys.get(backend) ?? null;
}

/**
 * Refresh the AI model registry (t/4162; TL t/4031#1-3; SO e/297#4) via the shared lib's
 * `refreshAIModels` (lib/electron-shared/modelDiscovery.ts, t/4160) — the same engine the Electron
 * IPC path (t/4161) calls, replacing the old per-backend probe that never wrote anything and didn't
 * match the `RefreshResult` shape the renderer bridge (`web-bridge.ts`) already declares.
 *
 * SO C1: no `accept` → `dryRun: true`, for every principal, admin included — the proposal/hash
 * review (TL t/4031#2 adj. 1) exists to stop an unreviewed selection-surface change, and a role check
 * is not a substitute. A non-dryRun call without `accept` gets a WARN naming the caller, and the
 * response carries `coerced: true` so the downgrade is never silent (SO risk 2).
 *
 * t/4318: non-write calls are served from a short-TTL cache (`refreshModelsCache.ts`) to bound
 * repeated provider-API probing; a write (`accept`) always bypasses and invalidates it.
 */
export async function refreshAIModels(opts: RefreshModelsRequestInput = {}): Promise<RefreshResult & { coerced?: boolean }> {
  const requestedWrite = opts.dryRun !== true;
  const coerced = requestedWrite && !opts.accept;
  const isWrite = !!opts.accept;
  if (coerced) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'ai-backends', level: 'warn',
      message: `refreshAIModels: non-dryRun call without an accepted proposal — coerced to dryRun (caller: ${getCurrentUserId()})`,
    });
  }

  const cached = !isWrite ? getCachedDryRun() : null;
  if (cached) {
    return coerced ? { ...cached, coerced: true } : cached;
  }

  const loadApiKey = await buildApiKeyLookup();
  const result = await libRefreshAIModels(
    { loadApiKey, repoRoot: getProjectRoot() },
    {
      dryRun: coerced ? true : opts.dryRun,
      // C3: `principal` is always the authenticated server identity, never client text —
      // `refreshModelsRequestSchema`'s `.strict()` already refuses a body that tries to set it.
      ...(opts.accept ? { accept: { ...opts.accept, principal: getCurrentUserId() } } : {}),
    },
  );

  if (isWrite) invalidateDryRunCache(); else setCachedDryRun(result);

  return coerced ? { ...result, coerced: true } : result;
}
