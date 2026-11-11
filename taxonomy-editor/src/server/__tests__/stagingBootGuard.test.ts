// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/77 Phase 0: Staging Boot Guard Tests
 *
 * Tests for stagingBootGuard.ts — validates that:
 * 1. Staging identity cannot access prod repo
 * 2. Prod identity cannot access staging repo
 * 3. Dev/test mode (no staging identity) allows any repo
 * 4. Staging must have non-default session branch prefix
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateStagingBootGuard, validateStagingBranchPrefix } from '../security/stagingBootGuard.js';
import { ActionableError } from '../../../../lib/debate/errors.js';

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

  describe('validateStagingBootGuard', () => {
    it('allows any repo in dev mode (no staging identity configured)', () => {
      // Dev mode: no staging App ID
      process.env.GITHUB_APP_ID = 'prod-app-id';
      process.env.GITHUB_REPO = 'AI-Rosetta-Stone/ai-triad-data';
      delete process.env.STAGING_APP_ID;
      delete process.env.STAGING_REPO;

      expect(() => validateStagingBootGuard()).not.toThrow();
    });

    it('allows staging identity to access staging repo', () => {
      process.env.GITHUB_APP_ID = 'staging-app-id';
      process.env.GITHUB_REPO = 'AI-Rosetta-Stone/ai-triad-data-staging';
      process.env.STAGING_APP_ID = 'staging-app-id';
      process.env.STAGING_REPO = 'AI-Rosetta-Stone/ai-triad-data-staging';

      expect(() => validateStagingBootGuard()).not.toThrow();
    });

    it('allows prod identity to access prod repo', () => {
      process.env.GITHUB_APP_ID = 'prod-app-id';
      process.env.GITHUB_REPO = 'AI-Rosetta-Stone/ai-triad-data';
      process.env.STAGING_APP_ID = 'staging-app-id';
      process.env.STAGING_REPO = 'AI-Rosetta-Stone/ai-triad-data-staging';

      expect(() => validateStagingBootGuard()).not.toThrow();
    });

    it('rejects staging identity targeting prod repo (mismatch)', () => {
      process.env.GITHUB_APP_ID = 'staging-app-id';
      process.env.GITHUB_REPO = 'AI-Rosetta-Stone/ai-triad-data'; // PROD repo!
      process.env.STAGING_APP_ID = 'staging-app-id';
      process.env.STAGING_REPO = 'AI-Rosetta-Stone/ai-triad-data-staging';

      expect(() => validateStagingBootGuard()).toThrow(ActionableError);
      expect(() => validateStagingBootGuard()).toThrow(/staging identity.*prod repo/);
    });

    it('rejects prod identity targeting staging repo (mismatch)', () => {
      process.env.GITHUB_APP_ID = 'prod-app-id';
      process.env.GITHUB_REPO = 'AI-Rosetta-Stone/ai-triad-data-staging'; // STAGING repo!
      process.env.STAGING_APP_ID = 'staging-app-id';
      process.env.STAGING_REPO = 'AI-Rosetta-Stone/ai-triad-data-staging';

      expect(() => validateStagingBootGuard()).toThrow(ActionableError);
      expect(() => validateStagingBootGuard()).toThrow(/prod identity.*staging repo/);
    });
  });

  describe('validateStagingBranchPrefix', () => {
    it('passes when staging has non-default branch prefix', () => {
      process.env.GITHUB_APP_ID = 'staging-app-id';
      process.env.STAGING_APP_ID = 'staging-app-id';
      process.env.SESSION_BRANCH_PREFIX = 'staging-session';

      expect(() => validateStagingBranchPrefix()).not.toThrow();
    });

    it('passes when prod has any branch prefix', () => {
      process.env.GITHUB_APP_ID = 'prod-app-id';
      process.env.STAGING_APP_ID = 'staging-app-id';
      process.env.SESSION_BRANCH_PREFIX = 'api-session'; // default is OK for prod

      expect(() => validateStagingBranchPrefix()).not.toThrow();
    });

    it('passes in dev mode (no staging identity)', () => {
      process.env.GITHUB_APP_ID = 'prod-app-id';
      delete process.env.STAGING_APP_ID;
      process.env.SESSION_BRANCH_PREFIX = 'api-session'; // even default is OK without staging

      expect(() => validateStagingBranchPrefix()).not.toThrow();
    });

    it('rejects staging with default branch prefix', () => {
      process.env.GITHUB_APP_ID = 'staging-app-id';
      process.env.STAGING_APP_ID = 'staging-app-id';
      process.env.SESSION_BRANCH_PREFIX = 'api-session'; // default — not allowed!

      expect(() => validateStagingBranchPrefix()).toThrow(ActionableError);
      expect(() => validateStagingBranchPrefix()).toThrow(/default.*branch.*prefix/);
    });

    it('rejects staging with unset branch prefix (defaults to undefined, treated as default)', () => {
      process.env.GITHUB_APP_ID = 'staging-app-id';
      process.env.STAGING_APP_ID = 'staging-app-id';
      delete process.env.SESSION_BRANCH_PREFIX;

      expect(() => validateStagingBranchPrefix()).toThrow(ActionableError);
      expect(() => validateStagingBranchPrefix()).toThrow(/unset/);
    });
  });
});
