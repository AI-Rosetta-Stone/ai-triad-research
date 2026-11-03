// @vitest-environment node

/**
 * t/4756 (t/4738 prevention, step 5): fail-closed boot validation for Azure blob container config.
 *
 * In a hosted profile (NODE_ENV=production), if AZURE_STORAGE_ACCOUNT_URL is set but any
 * of the three required container vars is unset, blob backends are not wired and /readyz
 * returns 503 so the deploy warm-gate blocks promotion.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('blobBackendBoot: fail-closed validation (t/4756)', () => {
  // Reset module state between tests via vi.resetModules() so blobBackendsWired state
  // doesn't carry over from one test to the next (it's a module-level variable).
  beforeEach(() => {
    vi.resetModules();
  });

  it('non-hosted profile (NODE_ENV !== production): backends always wired regardless of env vars', async () => {
    const { validateBlobBackendConfig, areBlobBackendsWired } = await import('../storage/blobBackendBoot.js');
    const env = {
      NODE_ENV: 'development',
      AZURE_STORAGE_ACCOUNT_URL: 'https://example.blob.core.windows.net',
      // intentionally missing AZURE_USER_CONTENT_CONTAINER etc.
    };
    const missing = validateBlobBackendConfig(env);
    expect(missing).toEqual([]);
    expect(areBlobBackendsWired()).toBe(true);
  });

  it('hosted profile without account URL: backends wired, no validation failure', async () => {
    const { validateBlobBackendConfig, areBlobBackendsWired } = await import('../storage/blobBackendBoot.js');
    const env = {
      NODE_ENV: 'production',
      // AZURE_STORAGE_ACCOUNT_URL intentionally absent
    };
    const missing = validateBlobBackendConfig(env);
    expect(missing).toEqual([]);
    expect(areBlobBackendsWired()).toBe(true);
  });

  it('hosted profile with account URL and all three container vars set: backends wired', async () => {
    const { validateBlobBackendConfig, areBlobBackendsWired } = await import('../storage/blobBackendBoot.js');
    const env = {
      NODE_ENV: 'production',
      AZURE_STORAGE_ACCOUNT_URL: 'https://example.blob.core.windows.net',
      AZURE_USER_CONTENT_CONTAINER: 'user-content',
      AZURE_COMMUNITY_CONTAINER: 'community',
      AZURE_BRIEF_EXPORTS_CONTAINER: 'brief-exports',
    };
    const missing = validateBlobBackendConfig(env);
    expect(missing).toEqual([]);
    expect(areBlobBackendsWired()).toBe(true);
  });

  it('hosted profile with account URL but missing one container var: backends not wired', async () => {
    const { validateBlobBackendConfig, areBlobBackendsWired } = await import('../storage/blobBackendBoot.js');
    const env = {
      NODE_ENV: 'production',
      AZURE_STORAGE_ACCOUNT_URL: 'https://example.blob.core.windows.net',
      AZURE_USER_CONTENT_CONTAINER: 'user-content',
      AZURE_COMMUNITY_CONTAINER: 'community',
      // AZURE_BRIEF_EXPORTS_CONTAINER missing
    };
    const missing = validateBlobBackendConfig(env);
    expect(missing).toEqual(['AZURE_BRIEF_EXPORTS_CONTAINER']);
    expect(areBlobBackendsWired()).toBe(false);
  });

  it('hosted profile with account URL but missing multiple container vars: backends not wired, all missing vars listed', async () => {
    const { validateBlobBackendConfig, areBlobBackendsWired } = await import('../storage/blobBackendBoot.js');
    const env = {
      NODE_ENV: 'production',
      AZURE_STORAGE_ACCOUNT_URL: 'https://example.blob.core.windows.net',
      // All three container vars missing
    };
    const missing = validateBlobBackendConfig(env);
    expect(missing).toContain('AZURE_USER_CONTENT_CONTAINER');
    expect(missing).toContain('AZURE_COMMUNITY_CONTAINER');
    expect(missing).toContain('AZURE_BRIEF_EXPORTS_CONTAINER');
    expect(areBlobBackendsWired()).toBe(false);
  });

  it('regression: stages align with their names (verify no semantic change when replacing local PROGRESS constant)', async () => {
    // This is a placeholder for when the stage progress integration is tested.
    // For now, just verify the container validation returns the expected missing vars.
    const { validateBlobBackendConfig, areBlobBackendsWired } = await import('../storage/blobBackendBoot.js');
    const env = {
      NODE_ENV: 'production',
      AZURE_STORAGE_ACCOUNT_URL: 'https://example.blob.core.windows.net',
      AZURE_USER_CONTENT_CONTAINER: 'prod-user-content',
      AZURE_COMMUNITY_CONTAINER: 'prod-community',
      AZURE_BRIEF_EXPORTS_CONTAINER: 'prod-brief-exports',
    };
    const missing = validateBlobBackendConfig(env);
    expect(missing).toEqual([]);
  });
});
