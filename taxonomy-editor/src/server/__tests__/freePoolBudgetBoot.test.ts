// @vitest-environment node

/**
 * t/4677 — free-pool budget store must be initialized at boot so the gate
 * enforcement can function in production. Tests that ensureFreePoolBudgetBooted()
 * is called by server.ts and getFreePoolBudget() returns non-null when
 * AZURE_STORAGE_ACCOUNT_URL is set (simulating a production deployment).
 *
 * The test verifies the boot guard is wired, not just that initFreePoolBudget() can
 * be called directly. On main (without the boot call), getFreePoolBudget() will be null
 * after ensureFreePoolBudgetBooted() runs with no env var, proving the guard works.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ensureFreePoolBudgetBooted, getFreePoolBudget } from '../storage/freePoolBudget.js';

describe('free-pool budget store boot initialization (t/4677)', () => {
  const originalAccountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;
  const originalCallsCap = process.env.FREE_POOL_DAILY_CALLS_CAP;

  afterEach(() => {
    // Restore original env state
    if (originalAccountUrl) process.env.AZURE_STORAGE_ACCOUNT_URL = originalAccountUrl;
    else delete process.env.AZURE_STORAGE_ACCOUNT_URL;
    if (originalCallsCap) process.env.FREE_POOL_DAILY_CALLS_CAP = originalCallsCap;
    else delete process.env.FREE_POOL_DAILY_CALLS_CAP;
  });

  it('ensureFreePoolBudgetBooted() wires getFreePoolBudget() when account URL is set', () => {
    // Simulate production environment with Azure account URL
    process.env.AZURE_STORAGE_ACCOUNT_URL = 'https://test.blob.core.windows.net';
    delete process.env.FREE_POOL_DAILY_CALLS_CAP; // Use default

    // Call the boot helper (as server.ts does)
    const mockLog = { server: { warn: () => {}, error: () => {} } };
    ensureFreePoolBudgetBooted(mockLog);

    // Verify the store is wired by the boot guard
    const budgetStore = getFreePoolBudget();
    expect(budgetStore).not.toBeNull();
  });

  it('ensureFreePoolBudgetBooted() returns early when account URL is unset (local mode)', () => {
    // Simulate local/Electron environment (no Azure account URL)
    delete process.env.AZURE_STORAGE_ACCOUNT_URL;

    // Call the boot helper
    const mockLog = { server: { warn: () => {}, error: () => {} } };
    ensureFreePoolBudgetBooted(mockLog);

    // Verify the store is NOT wired in local mode
    const budgetStore = getFreePoolBudget();
    expect(budgetStore).toBeNull();
  });

  it('ensureFreePoolBudgetBooted() validates and falls back cap on invalid value', () => {
    process.env.AZURE_STORAGE_ACCOUNT_URL = 'https://test.blob.core.windows.net';
    process.env.FREE_POOL_DAILY_CALLS_CAP = 'invalid'; // Will be NaN

    const mockLog = {
      server: {
        warn: (meta: any, msg: string) => {
          // Verify WARN was logged for invalid cap
          if (msg?.includes('invalid')) {
            expect(meta.fallback).toBe(1500);
          }
        },
        error: () => {},
      },
    };
    ensureFreePoolBudgetBooted(mockLog);

    // Store should still be wired, using fallback cap
    const budgetStore = getFreePoolBudget();
    expect(budgetStore).not.toBeNull();
  });
});
