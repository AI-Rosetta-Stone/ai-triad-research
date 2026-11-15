// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4954 (t/97): which store server.ts boots analytics against. The old inline
// `AZURE_ANALYTICS_CONTAINER || 'analytics'` meant a staging deploy missing the var wrote its
// events into PROD's `analytics` container (a ~49h leak in a past incident). Hosted mode now
// never falls back: with the var unset, analytics isn't initialized at all, and
// storage/blobBackendBoot's validateBlobBackendConfig holds /readyz at 503 (t/96) so the
// deploy's pre-traffic smoke catches it. "Hosted" uses that function's rule exactly.

import { ActionableError } from '../../../lib/debate/errors.js';
import { log } from './logger.js';

/** Container local/dev blob mode (e.g. Azurite with NODE_ENV unset) still defaults to. */
export const LOCAL_DEFAULT_ANALYTICS_CONTAINER = 'analytics';

export type AnalyticsBootPlan =
  | { kind: 'azure-blob'; accountUrl: string; container: string }
  | { kind: 'filesystem' }
  | { kind: 'disabled'; error: ActionableError };

/**
 * Pure apart from logging: decide the analytics store from env. Logs a WARN when local blob
 * mode takes the default container, and an error (ActionableError form) when hosted mode is
 * missing AZURE_ANALYTICS_CONTAINER.
 */
export function resolveAnalyticsBootPlan(env: NodeJS.ProcessEnv = process.env): AnalyticsBootPlan {
  const accountUrl = env.AZURE_STORAGE_ACCOUNT_URL;
  if (!accountUrl) return { kind: 'filesystem' };

  const container = env.AZURE_ANALYTICS_CONTAINER;
  if (container) return { kind: 'azure-blob', accountUrl, container };

  if (env.NODE_ENV === 'production') {
    const error = new ActionableError({
      goal: 'Initialize analytics storage against this environment\'s own blob container',
      problem: 'AZURE_ANALYTICS_CONTAINER is unset in hosted mode; analytics is NOT initialized rather than falling back to prod\'s `analytics` container',
      location: 'taxonomy-editor/src/server/analyticsBootConfig.ts resolveAnalyticsBootPlan',
      nextSteps: [
        'Set AZURE_ANALYTICS_CONTAINER on the container app (deploy/azure/main.bicep sets `analytics` for prod, `staging-analytics` for staging)',
        'Redeploy; /readyz stays 503 until it is set (t/4954)',
      ],
    });
    log.analytics.error({ component: 'analytics', missing: 'AZURE_ANALYTICS_CONTAINER', err: error }, error.message);
    return { kind: 'disabled', error };
  }

  log.analytics.warn(
    { component: 'analytics', container: LOCAL_DEFAULT_ANALYTICS_CONTAINER, reason: 'AZURE_ANALYTICS_CONTAINER unset, not hosted' },
    'Analytics falling back to the local default blob container',
  );
  return { kind: 'azure-blob', accountUrl, container: LOCAL_DEFAULT_ANALYTICS_CONTAINER };
}
