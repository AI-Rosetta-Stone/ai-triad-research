// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { RefreshResult } from '../../../../lib/electron-shared/modelDiscovery.js';

/**
 * t/4162 C5 (decision recorded t/4318): every non-accept call to `refreshAIModels` is a dry
 * run (coerced or explicit) that probes live provider APIs — t/4162 C1 means EVERY signed-in
 * caller gets this, including New Debate/Op-Ed dialogs that don't pass `dryRun` explicitly
 * (t/4317). A short TTL bounds repeated provider-API calls cheaply without rejecting
 * legitimate read traffic the way a rate-limiter would; the provider catalogs change rarely
 * enough that a 60s-stale dry-run is correctness-neutral here. `getApiKeyForListing` takes no
 * userId (the keys are server-wide admin config, not per-user BYOK), so one cached result is
 * valid for every caller — no per-user keying needed. Extracted to its own module to keep
 * aiBackends.ts under its max-lines budget (t/4318).
 */
const DRY_RUN_CACHE_TTL_MS = 60_000;
let cache: { result: RefreshResult; expiresAt: number } | null = null;

/** Returns the cached dry-run result if still within the TTL, else null. */
export function getCachedDryRun(): RefreshResult | null {
  return cache && cache.expiresAt > Date.now() ? cache.result : null;
}

/** Caches a fresh dry-run result. */
export function setCachedDryRun(result: RefreshResult): void {
  cache = { result, expiresAt: Date.now() + DRY_RUN_CACHE_TTL_MS };
}

/** The committed registry just changed (a write/accept happened) — drop the cache so the
 *  next dry-run compares against current state, not a proposal that's now stale. */
export function invalidateDryRunCache(): void {
  cache = null;
}

/** Test-only: clear the cache so each test starts from a clean state. */
export function clearRefreshAIModelsCacheForTests(): void {
  cache = null;
}
