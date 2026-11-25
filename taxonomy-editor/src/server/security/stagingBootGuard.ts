// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/77 Phase 0: Staging Boot Guard
 *
 * Fail-closed guard that stops a staging container from booting against the
 * prod data repo, the prod GitHub App, or the prod `main` branch.
 *
 * The staging decision is keyed on CONTAINER_APP_NAME, which the platform sets
 * and the override pipeline (t/4794) does not touch. It is NOT keyed on the
 * GITHUB_* or STAGING_* values, because those are the values an override loss
 * drops together (t/77#3 condition 1). When a staging container is missing any
 * identity value, or any value disagrees, boot is refused. Nothing falls back
 * to a "dev" path.
 *
 * Prod and dev containers only get the mismatch check: the prod repo must not
 * be the staging repo.
 *
 * Both checks run at boot, before GitHubAPIBackend is constructed.
 */

import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../../lib/debate/errors.js';

/** The prod data repo. Staging must never target it, whatever the env says. */
const PROD_DATA_REPO = 'AI-Rosetta-Stone/ai-triad-data';

/** The session branch prefix the prod container uses. Staging must not use it. */
const DEFAULT_SESSION_BRANCH_PREFIX = 'api-session';

/** The branch whose writes reach prod data. Staging must never write to it. */
const PROD_BRANCH = 'main';

/**
 * True when the platform says this container is staging. The Container App
 * name ends in "-staging" (for example "taxonomy-editor-staging").
 */
function isStagingContainer(): boolean {
  const name = process.env.CONTAINER_APP_NAME;
  return Boolean(name) && /-staging$/.test(name as string);
}

function recordGuardFailure(
  message: string,
  details: Record<string, string | undefined>,
  error: ActionableError
): void {
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'staging-boot-guard',
    level: 'error',
    message,
    error: { name: 'StagingBootGuardFailed', message: error.message, ...details },
  });
  log.security.error({ ...details }, `Staging boot guard FAILED: ${message}`);
}

function guardError(
  goal: string,
  problem: string,
  nextSteps: string[],
  recordMessage: string,
  details: Record<string, string | undefined>
): never {
  const err = Object.assign(
    new ActionableError({
      goal,
      problem,
      location: 'security/stagingBootGuard.ts',
      nextSteps: [...nextSteps, 'This is a fail-closed check. Do not bypass it.'],
    }),
    { statusCode: 500 }
  );
  recordGuardFailure(recordMessage, details, err);
  throw err;
}

/**
 * Staging must have every identity value set, and they must agree. Throws if
 * the container is staging and anything is missing or wrong.
 */
export function validateStagingBootGuard(): void {
  const appId = process.env.GITHUB_APP_ID;
  const repo = process.env.GITHUB_REPO;
  const stagingAppId = process.env.STAGING_APP_ID;
  const stagingRepo = process.env.STAGING_REPO;
  const branch = process.env.GITHUB_BRANCH;
  const details = {
    containerAppName: process.env.CONTAINER_APP_NAME,
    appId,
    repo,
    stagingAppId,
    stagingRepo,
    branch,
  };

  if (!isStagingContainer()) {
    // Prod and dev: only refuse the prod container pointing at the staging repo.
    if (stagingRepo && repo === stagingRepo) {
      guardError(
        'Prevent prod identity from accessing staging data',
        `Prod container is targeting staging repo "${repo}".`,
        [
          'Verify GITHUB_REPO on the prod container.',
          `Prod data repo: ${PROD_DATA_REPO}`,
        ],
        'prod container targeting staging repo',
        details
      );
    }
    log.auth.info(details, 'Staging boot guard: non-staging container, no staging checks');
    return;
  }

  // Staging: every value must be present. An unset value is a refusal, not a dev fallback.
  const missing = Object.entries({
    GITHUB_APP_ID: appId,
    STAGING_APP_ID: stagingAppId,
    GITHUB_REPO: repo,
    STAGING_REPO: stagingRepo,
    GITHUB_BRANCH: branch,
  })
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    guardError(
      'Prevent staging from booting without a verified identity',
      `Staging container cannot verify its identity: unset ${missing.join(', ')}.`,
      [
        `Set ${missing.join(', ')} on the staging container before starting.`,
        'Check for an override loss (t/4794): the staging env overrides may have been dropped.',
      ],
      'staging identity unset',
      details
    );
  }

  if (appId !== stagingAppId) {
    guardError(
      'Prevent staging identity from running as prod',
      `Staging container is using App ID ${appId}, not the staging App ID ${stagingAppId}.`,
      ['Verify GITHUB_APP_ID and STAGING_APP_ID on the staging container.'],
      'staging container with non-staging App id',
      details
    );
  }

  if (repo === PROD_DATA_REPO || repo !== stagingRepo) {
    guardError(
      'Prevent staging identity from accessing prod data',
      `Staging container is targeting repo "${repo}" instead of staging repo "${stagingRepo}".`,
      [
        'Verify GITHUB_REPO and STAGING_REPO on the staging container.',
        `Prod data repo (never allowed for staging): ${PROD_DATA_REPO}`,
      ],
      'staging identity targeting prod repo',
      details
    );
  }

  if (branch === PROD_BRANCH) {
    guardError(
      'Prevent staging from writing to prod main',
      `Staging container resolves GITHUB_BRANCH to "${PROD_BRANCH}".`,
      ['Set GITHUB_BRANCH to the staging branch on the staging container.'],
      'staging branch resolves to main',
      details
    );
  }

  log.auth.info(details, 'Staging boot guard: staging identity verified ✓');
}

/**
 * Staging must have a non-default session branch prefix, so that an unset or
 * overridden SESSION_BRANCH_PREFIX cannot send staging sessions to the prod
 * branch namespace (t/77 SO condition 2). Throws on staging when the prefix is
 * unset or default. Does nothing on non-staging containers.
 */
export function validateStagingBranchPrefix(): void {
  if (!isStagingContainer()) return;

  const branchPrefix = process.env.SESSION_BRANCH_PREFIX;
  const details = {
    containerAppName: process.env.CONTAINER_APP_NAME,
    branchPrefix: branchPrefix || '(unset)',
    defaultPrefix: DEFAULT_SESSION_BRANCH_PREFIX,
  };

  if (!branchPrefix || branchPrefix === DEFAULT_SESSION_BRANCH_PREFIX) {
    guardError(
      'Prevent staging from defaulting to prod session branch prefix',
      `Staging container has default SESSION_BRANCH_PREFIX "${branchPrefix || '(unset)'}", which would send staging sessions into the prod branch namespace.`,
      [
        'Set SESSION_BRANCH_PREFIX to a non-default value (for example "staging-session").',
        `Default value: ${DEFAULT_SESSION_BRANCH_PREFIX}`,
      ],
      'staging branch prefix is default or unset',
      details
    );
  }

  log.auth.info(details, 'Staging boot guard: branch prefix is non-default ✓');
}
