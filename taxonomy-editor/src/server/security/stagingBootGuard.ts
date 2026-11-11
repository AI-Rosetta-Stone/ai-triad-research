// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/77 Phase 0: Staging Boot Guard
 *
 * Fail-closed guard to prevent staging identity from accessing prod data repo,
 * or prod identity from accessing staging repo. This mitigates the correlated
 * override-loss risk identified in t/77#4 (SO conditions: staging must boot
 * with non-default identity markers and refuse mismatched repos).
 *
 * The guard is keyed on GitHub App ID (stable, per-environment identity marker)
 * and verifies that:
 *   - If running with staging App ID → repo must be staging repo
 *   - If running with prod App ID → repo must be prod repo
 *   - If running with neither (dev/test) → both repos are allowed
 *
 * This is enforced at boot time (GitHubAPIBackend initialization) to fail fast
 * before any data I/O.
 */

import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../../lib/debate/errors.js';

/**
 * Environment-specific identity markers. These are stable, deployment-level
 * values (never per-user or session). They're used to detect which identity
 * is running and enforce repo isolation.
 *
 * Populated from environment variables:
 *   - GITHUB_APP_ID: The GitHub App ID for this deployment
 *   - GITHUB_REPO: The data repository this deployment targets
 *   - STAGING_APP_ID: (optional) The staging App ID, if different from prod
 *   - STAGING_REPO: (optional) The staging data repo, if different from prod
 *
 * If STAGING_* are unset, both staging and prod are treated as "not configured"
 * (no isolation enforced in dev/test mode).
 */
interface DeploymentIdentity {
  appId: string | null;
  repo: string | null;
  stagingAppId: string | null;
  stagingRepo: string | null;
}

/**
 * Extract deployment identity from environment. Returns the stable, per-deployment
 * App ID and repo pairs.
 */
function getDeploymentIdentity(): DeploymentIdentity {
  return {
    appId: process.env.GITHUB_APP_ID ?? null,
    repo: process.env.GITHUB_REPO ?? null,
    stagingAppId: process.env.STAGING_APP_ID ?? null,
    stagingRepo: process.env.STAGING_REPO ?? null,
  };
}

/**
 * Determine which identity (staging or prod) is active based on the App ID.
 * Returns 'staging', 'prod', or 'dev' (neither configured).
 */
function detectActiveIdentity(identity: DeploymentIdentity): 'staging' | 'prod' | 'dev' {
  const { appId, stagingAppId } = identity;

  // Neither staging nor prod App ID configured → dev/test mode, no isolation
  if (!stagingAppId && !appId) return 'dev';

  // Staging App ID matches current config → running as staging
  if (stagingAppId && appId === stagingAppId) return 'staging';

  // Prod App ID is set and doesn't match staging → running as prod
  if (appId && appId !== stagingAppId) return 'prod';

  // If we reach here, only staging is configured but appId doesn't match
  // (e.g., staging is set but appId is different). Treat as dev.
  return 'dev';
}

/**
 * Validate that the active identity's repo is correct.
 * Throws ActionableError if mismatch detected.
 */
export function validateStagingBootGuard(): void {
  const identity = getDeploymentIdentity();
  const activeIdentity = detectActiveIdentity(identity);

  const { appId, repo, stagingAppId, stagingRepo } = identity;

  // If no staging is configured (dev mode), allow any repo
  if (!stagingAppId) {
    log.auth.info(
      { activeIdentity, appId, repo, stagingAppId, stagingRepo },
      'Staging boot guard: dev mode (no staging identity configured), allowing any repo'
    );
    return;
  }

  // Staging identity must match staging repo
  if (activeIdentity === 'staging') {
    if (repo === stagingRepo) {
      log.auth.info(
        { activeIdentity, appId, repo, stagingAppId, stagingRepo },
        'Staging boot guard: staging identity correctly targeting staging repo ✓'
      );
      return;
    }
    const err = Object.assign(
      new ActionableError({
        goal: 'Prevent staging identity from accessing prod data',
        problem: `Staging boot guard failed: staging identity (App ID ${stagingAppId}) is targeting prod repo "${repo}" instead of staging repo "${stagingRepo}"`,
        location: 'security/stagingBootGuard.ts → validateStagingBootGuard',
        nextSteps: [
          `Verify the deployment's GITHUB_REPO and STAGING_REPO environment variables are set correctly.`,
          `Staging App ID: ${stagingAppId}`,
          `Staging Repo: ${stagingRepo}`,
          `Current Repo: ${repo}`,
          'This is a fail-closed check to prevent accidental staging-to-prod writes after an override loss.',
          'Do not bypass this guard.',
        ],
      }),
      { statusCode: 500 }
    );
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'staging-boot-guard',
      level: 'error',
      message: 'Staging boot guard failed: identity/repo mismatch',
      error: {
        name: 'StagingBootGuardFailed',
        message: err.message,
        activeIdentity,
        appId,
        repo,
        stagingAppId,
        stagingRepo,
      },
    });
    log.security.error(
      { activeIdentity, appId, repo, stagingAppId, stagingRepo },
      'Staging boot guard FAILED: staging identity targeting prod repo'
    );
    throw err;
  }

  // Prod identity must not target staging repo
  if (activeIdentity === 'prod') {
    if (repo !== stagingRepo) {
      log.auth.info(
        { activeIdentity, appId, repo, stagingAppId, stagingRepo },
        'Staging boot guard: prod identity correctly targeting prod repo ✓'
      );
      return;
    }
    const err = Object.assign(
      new ActionableError({
        goal: 'Prevent prod identity from accessing staging data',
        problem: `Staging boot guard failed: prod identity (App ID ${appId}) is targeting staging repo "${repo}" instead of prod repo`,
        location: 'security/stagingBootGuard.ts → validateStagingBootGuard',
        nextSteps: [
          `Verify the deployment's GITHUB_REPO and STAGING_REPO environment variables are set correctly.`,
          `Prod App ID: ${appId}`,
          `Staging App ID: ${stagingAppId}`,
          `Current Repo: ${repo}`,
          'This is a fail-closed check to prevent accidental repo confusion.',
          'Do not bypass this guard.',
        ],
      }),
      { statusCode: 500 }
    );
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'staging-boot-guard',
      level: 'error',
      message: 'Staging boot guard failed: prod targeting staging',
      error: {
        name: 'StagingBootGuardFailed',
        message: err.message,
        activeIdentity,
        appId,
        repo,
        stagingAppId,
        stagingRepo,
      },
    });
    log.security.error(
      { activeIdentity, appId, repo, stagingAppId, stagingRepo },
      'Staging boot guard FAILED: prod identity targeting staging repo'
    );
    throw err;
  }
}

/**
 * Validate the session branch prefix to ensure it is non-default.
 * This prevents staging from silently falling back to the default prefix
 * if SESSION_BRANCH_PREFIX is unset or overridden (t/77 SO condition 2).
 *
 * Returns true if validation passes (or not applicable in dev mode).
 * Throws ActionableError if the prefix is default and staging is configured.
 */
export function validateStagingBranchPrefix(): void {
  const { stagingAppId } = getDeploymentIdentity();
  const appId = process.env.GITHUB_APP_ID;

  // If no staging App ID configured, no isolation enforcement
  if (!stagingAppId) return;

  const isStaging = appId === stagingAppId;
  if (!isStaging) return; // Prod is allowed any prefix

  const branchPrefix = process.env.SESSION_BRANCH_PREFIX;
  const defaultPrefix = 'api-session';

  // Staging must have a non-default prefix (e.g., "staging-session")
  if (!branchPrefix || branchPrefix === defaultPrefix) {
    const err = Object.assign(
      new ActionableError({
        goal: 'Prevent staging from defaulting to prod session branch prefix',
        problem: `Staging environment has default SESSION_BRANCH_PREFIX "${branchPrefix || '(unset)'}", which would merge staging sessions into prod main after an override loss.`,
        location: 'security/stagingBootGuard.ts → validateStagingBranchPrefix',
        nextSteps: [
          `Set SESSION_BRANCH_PREFIX to a non-default value (e.g., "staging-session").`,
          `Current value: ${branchPrefix || '(unset)'}`,
          `Default value: ${defaultPrefix}`,
          `Verify the deployment's SESSION_BRANCH_PREFIX environment variable before starting.`,
        ],
      }),
      { statusCode: 500 }
    );
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'staging-boot-guard',
      level: 'error',
      message: 'Staging boot guard failed: default branch prefix',
      error: {
        name: 'StagingBootGuardFailed',
        message: err.message,
        branchPrefix,
        stagingAppId,
        appId,
      },
    });
    log.security.error(
      { branchPrefix, stagingAppId, appId },
      'Staging boot guard FAILED: default branch prefix detected'
    );
    throw err;
  }

  log.auth.info(
    { branchPrefix, stagingAppId, appId },
    'Staging boot guard: branch prefix is non-default ✓'
  );
}
