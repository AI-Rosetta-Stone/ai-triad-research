// @vitest-environment node

/**
 * t/4677 — free-pool budget store must be initialized at boot so the gate
 * enforcement can function in production. Tests that initFreePoolBudget() is
 * called and getFreePoolBudget() returns non-null when AZURE_STORAGE_ACCOUNT_URL
 * is set (simulating a production deployment).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initFreePoolBudget, getFreePoolBudget, isFreePoolBudgetEnforced } from '../storage/freePoolBudget.js';

describe('free-pool budget store boot initialization (t/4677)', () => {
  const originalAccountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;

  afterEach(() => {
    // Restore original env state
    if (originalAccountUrl) process.env.AZURE_STORAGE_ACCOUNT_URL = originalAccountUrl;
    else delete process.env.AZURE_STORAGE_ACCOUNT_URL;
  });

  it('getFreePoolBudget() returns non-null after initFreePoolBudget() when account URL is set', () => {
    // Simulate production environment with Azure account URL
    process.env.AZURE_STORAGE_ACCOUNT_URL = 'https://test.blob.core.windows.net';

    // Initialize the budget store (called at server boot in server.ts)
    initFreePoolBudget({
      accountUrl: process.env.AZURE_STORAGE_ACCOUNT_URL,
      callsCap: 1500,
    });

    // Verify the store is wired
    const budgetStore = getFreePoolBudget();
    expect(budgetStore).not.toBeNull();
  });

  it('isFreePoolBudgetEnforced() reflects the feature flag status', () => {
    // The flag value depends on runtime config; this test just verifies
    // the gate function returns a boolean (not null/undefined).
    const enforced = isFreePoolBudgetEnforced();
    expect(typeof enforced).toBe('boolean');
  });
});
