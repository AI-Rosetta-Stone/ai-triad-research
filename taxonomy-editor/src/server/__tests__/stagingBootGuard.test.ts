// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/77 Phase 0: Staging Boot Guard Tests
 *
 * Tests for stagingBootGuard.ts. The staging decision is keyed on
 * CONTAINER_APP_NAME, so these tests cover:
 * 1. A staging container refuses to boot when any identity value is unset
 * 2. A staging container refuses the prod App, the prod repo, and main
 * 3. A staging container with every value correct boots
 * 4. A staging container needs a non-default session branch prefix
 * 5. A prod or dev container only refuses to target the staging repo
 */

import { describe, it, expect, afterEach } from 'vitest';
import { validateStagingBootGuard, validateStagingBranchPrefix } from '../security/stagingBootGuard.js';
import { ActionableError } from '../../../../lib/debate/errors.js';

const PROD_REPO = 'AI-Rosetta-Stone/ai-triad-data';
const STAGING_REPO = 'AI-Rosetta-Stone/ai-triad-data-staging';

/** A fully-configured staging container. Tests remove one value at a time. */
function setStagingEnv(): void {
  process.env.CONTAINER_APP_NAME = 'taxonomy-editor-staging';
  process.env.GITHUB_APP_ID = 'staging-app-id';
  process.env.STAGING_APP_ID = 'staging-app-id';
  process.env.GITHUB_REPO = STAGING_REPO;
  process.env.STAGING_REPO = STAGING_REPO;
  process.env.GITHUB_BRANCH = 'staging';
  process.env.SESSION_BRANCH_PREFIX = 'staging-session';
}

describe('stagingBootGuard', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore environment after each test
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);
  });

  describe('validateStagingBootGuard, staging container', () => {
    it('boots when every identity value is set and correct', () => {
      setStagingEnv();

      expect(() => validateStagingBootGuard()).not.toThrow();
    });

    it('refuses when STAGING_APP_ID is unset (no silent dev path)', () => {
      setStagingEnv();
      delete process.env.STAGING_APP_ID;

      expect(() => validateStagingBootGuard()).toThrow(ActionableError);
      expect(() => validateStagingBootGuard()).toThrow(/unset.*STAGING_APP_ID/);
    });

    it('refuses when GITHUB_APP_ID is unset while STAGING_APP_ID is set', () => {
      setStagingEnv();
      delete process.env.GITHUB_APP_ID;

      expect(() => validateStagingBootGuard()).toThrow(ActionableError);
      expect(() => validateStagingBootGuard()).toThrow(/unset.*GITHUB_APP_ID/);
    });

    it('refuses when GITHUB_REPO is unset', () => {
      setStagingEnv();
      delete process.env.GITHUB_REPO;

      expect(() => validateStagingBootGuard()).toThrow(/unset.*GITHUB_REPO/);
    });

    it('refuses when STAGING_REPO is unset', () => {
      setStagingEnv();
      delete process.env.STAGING_REPO;

      expect(() => validateStagingBootGuard()).toThrow(/unset.*STAGING_REPO/);
    });

    it('refuses when GITHUB_BRANCH is unset (default would be main)', () => {
      setStagingEnv();
      delete process.env.GITHUB_BRANCH;

      expect(() => validateStagingBootGuard()).toThrow(/unset.*GITHUB_BRANCH/);
    });

    it('refuses when every identity value is unset', () => {
      setStagingEnv();
      delete process.env.GITHUB_APP_ID;
      delete process.env.STAGING_APP_ID;
      delete process.env.GITHUB_REPO;
      delete process.env.STAGING_REPO;
      delete process.env.GITHUB_BRANCH;

      expect(() => validateStagingBootGuard()).toThrow(ActionableError);
    });

    it('refuses when the App id is the prod App, even with STAGING_APP_ID set to it', () => {
      setStagingEnv();
      process.env.GITHUB_APP_ID = 'prod-app-id';

      expect(() => validateStagingBootGuard()).toThrow(/not the staging App ID/);
    });

    it('refuses when GITHUB_REPO is the prod repo, even if STAGING_REPO also says prod', () => {
      setStagingEnv();
      process.env.GITHUB_REPO = PROD_REPO;
      process.env.STAGING_REPO = PROD_REPO;

      expect(() => validateStagingBootGuard()).toThrow(/prod data/);
    });

    it('refuses when GITHUB_REPO differs from STAGING_REPO', () => {
      setStagingEnv();
      process.env.GITHUB_REPO = PROD_REPO;

      expect(() => validateStagingBootGuard()).toThrow(/prod data/);
    });

    it('refuses when the branch resolves to main', () => {
      setStagingEnv();
      process.env.GITHUB_BRANCH = 'main';

      expect(() => validateStagingBootGuard()).toThrow(/prod main/);
    });
  });

  describe('validateStagingBootGuard, prod and dev containers', () => {
    it('allows prod to target the prod repo', () => {
      process.env.CONTAINER_APP_NAME = 'taxonomy-editor';
      process.env.GITHUB_APP_ID = 'prod-app-id';
      process.env.GITHUB_REPO = PROD_REPO;
      process.env.STAGING_REPO = STAGING_REPO;

      expect(() => validateStagingBootGuard()).not.toThrow();
    });

    it('refuses prod targeting the staging repo', () => {
      process.env.CONTAINER_APP_NAME = 'taxonomy-editor';
      process.env.GITHUB_APP_ID = 'prod-app-id';
      process.env.GITHUB_REPO = STAGING_REPO;
      process.env.STAGING_REPO = STAGING_REPO;

      expect(() => validateStagingBootGuard()).toThrow(/Prod container is targeting staging repo/);
    });

    it('allows dev with no identity configured', () => {
      delete process.env.CONTAINER_APP_NAME;
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_REPO;
      delete process.env.STAGING_APP_ID;
      delete process.env.STAGING_REPO;

      expect(() => validateStagingBootGuard()).not.toThrow();
    });
  });

  describe('validateStagingBranchPrefix', () => {
    it('passes when staging has a non-default branch prefix', () => {
      setStagingEnv();

      expect(() => validateStagingBranchPrefix()).not.toThrow();
    });

    it('rejects staging with the default branch prefix', () => {
      setStagingEnv();
      process.env.SESSION_BRANCH_PREFIX = 'api-session';

      expect(() => validateStagingBranchPrefix()).toThrow(ActionableError);
      expect(() => validateStagingBranchPrefix()).toThrow(/default SESSION_BRANCH_PREFIX/);
    });

    it('rejects staging with an unset branch prefix', () => {
      setStagingEnv();
      delete process.env.SESSION_BRANCH_PREFIX;

      expect(() => validateStagingBranchPrefix()).toThrow(ActionableError);
      expect(() => validateStagingBranchPrefix()).toThrow(/unset/);
    });

    it('rejects staging when GITHUB_APP_ID is unset (prefix check does not go silent)', () => {
      setStagingEnv();
      delete process.env.GITHUB_APP_ID;
      delete process.env.SESSION_BRANCH_PREFIX;

      expect(() => validateStagingBranchPrefix()).toThrow(/unset/);
    });

    it('passes on prod with the default prefix', () => {
      process.env.CONTAINER_APP_NAME = 'taxonomy-editor';
      process.env.SESSION_BRANCH_PREFIX = 'api-session';

      expect(() => validateStagingBranchPrefix()).not.toThrow();
    });

    it('passes on dev with no container name', () => {
      delete process.env.CONTAINER_APP_NAME;
      delete process.env.SESSION_BRANCH_PREFIX;

      expect(() => validateStagingBranchPrefix()).not.toThrow();
    });
  });
});
