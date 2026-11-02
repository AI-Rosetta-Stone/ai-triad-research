// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4756 (t/4738 prevention, step 5): fail-closed boot validation for Azure blob container config.
 *
 * In a hosted profile (NODE_ENV=production), if AZURE_STORAGE_ACCOUNT_URL is set but any
 * of the three required container vars (AZURE_USER_CONTENT_CONTAINER, AZURE_COMMUNITY_CONTAINER,
 * AZURE_BRIEF_EXPORTS_CONTAINER) is unset, refuse to wire the blob backends and return 503
 * from /readyz so the deploy warm-gate blocks promotion.
 *
 * **This validation must run synchronously at boot, BEFORE server.listen().**
 */

import { log } from '../logger.js';

const DEFAULT_USER_CONTENT_CONTAINER = 'user-content';
const DEFAULT_COMMUNITY_CONTAINER = 'community';
const DEFAULT_BRIEF_EXPORTS_CONTAINER = 'brief-exports';

/** Initialize to true; set to false only by fail-closed validation. */
let blobBackendsWired = true;

/**
 * Returns true if blob backends are wired, false if boot validation determined
 * they should not be (hosted + account URL + missing container var).
 */
export function areBlobBackendsWired(): boolean {
  return blobBackendsWired;
}

/**
 * Validate Azure blob container config at boot time. Must be called synchronously
 * before server.listen(). In hosted mode (NODE_ENV=production), if
 * AZURE_STORAGE_ACCOUNT_URL is set, all three container vars must also be set.
 *
 * On validation failure:
 * - Sets blobBackendsWired = false
 * - Logs ERROR with missing var names
 * - Returns the list of missing var names (used for error body/logs)
 */
export function validateBlobBackendConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const isHosted = env.NODE_ENV === 'production';
  const accountUrl = env.AZURE_STORAGE_ACCOUNT_URL;

  // Non-hosted profile: keep defaults, backends are wired.
  if (!isHosted) {
    return [];
  }

  // Hosted + no account URL: fallback to GitHub, backends are wired.
  if (!accountUrl) {
    return [];
  }

  // Hosted + account URL + check all three container vars.
  const missing: string[] = [];
  if (!env.AZURE_USER_CONTENT_CONTAINER) missing.push('AZURE_USER_CONTENT_CONTAINER');
  if (!env.AZURE_COMMUNITY_CONTAINER) missing.push('AZURE_COMMUNITY_CONTAINER');
  if (!env.AZURE_BRIEF_EXPORTS_CONTAINER) missing.push('AZURE_BRIEF_EXPORTS_CONTAINER');

  if (missing.length > 0) {
    blobBackendsWired = false;
    log.server.error(
      { accountUrl, missing },
      'Blob backend config missing required env vars: backends not wired',
    );
    return missing;
  }

  // All three set, backends are wired.
  return [];
}
