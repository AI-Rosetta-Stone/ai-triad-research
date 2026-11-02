// @vitest-environment node

/**
 * t/4677 — free-pool budget store must be initialized at boot so the gate
 * enforcement can function in production. Tests that ensureFreePoolBudgetBooted()
 * is called by server.ts and getFreePoolBudget() returns non-null when
 * AZURE_STORAGE_ACCOUNT_URL is set (simulating a production deployment).
 *
 * R1: Source-text guard verifies server.ts contains the ensureFreePoolBudgetBooted
 * call; this test fails if the call is removed, proving the boot guard is wired.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ensureFreePoolBudgetBooted, getFreePoolBudget, getFreePoolBudgetConfig, _resetFreePoolBudgetForTest } from '../storage/freePoolBudget.js';
import { freePoolBudgetHealth } from '../routes/meta.js';

describe('free-pool budget store boot initialization (t/4677)', () => {
  const originalAccountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;
  const originalCallsCap = process.env.FREE_POOL_DAILY_CALLS_CAP;
  const originalContainer = process.env.AZURE_USER_CONTENT_CONTAINER;

  beforeEach(() => {
    // Reset the module-level store to ensure test isolation
    _resetFreePoolBudgetForTest();
    // Clear env vars to ensure clean state
    delete process.env.AZURE_STORAGE_ACCOUNT_URL;
    delete process.env.FREE_POOL_DAILY_CALLS_CAP;
    delete process.env.AZURE_USER_CONTENT_CONTAINER;
  });

  afterEach(() => {
    // Restore original env state
    if (originalAccountUrl) process.env.AZURE_STORAGE_ACCOUNT_URL = originalAccountUrl;
    else delete process.env.AZURE_STORAGE_ACCOUNT_URL;
    if (originalCallsCap) process.env.FREE_POOL_DAILY_CALLS_CAP = originalCallsCap;
    else delete process.env.FREE_POOL_DAILY_CALLS_CAP;
    if (originalContainer) process.env.AZURE_USER_CONTENT_CONTAINER = originalContainer;
    else delete process.env.AZURE_USER_CONTENT_CONTAINER;
  });

  it('R1: server.ts calls ensureFreePoolBudgetBooted() at boot (guard fails if removed)', () => {
    // Source-text guard: verify the call exists in server.ts. If removed, test fails.
    const serverPath = path.join(__dirname, '..', 'server.ts');
    const serverSource = fs.readFileSync(serverPath, 'utf-8');
    expect(serverSource).toContain('ensureFreePoolBudgetBooted(log)');
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
    const mockLog = { server: { warn: vi.fn(), error: () => {} } };
    ensureFreePoolBudgetBooted(mockLog);

    // Verify WARN was logged for missing account URL
    expect(mockLog.server.warn).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'free-pool-budget' }),
      expect.stringContaining('AZURE_STORAGE_ACCOUNT_URL not set')
    );

    // Verify the store is NOT wired in local mode
    const budgetStore = getFreePoolBudget();
    expect(budgetStore).toBeNull();
  });

  it('ensureFreePoolBudgetBooted() validates and falls back cap on invalid value', () => {
    process.env.AZURE_STORAGE_ACCOUNT_URL = 'https://test.blob.core.windows.net';
    process.env.FREE_POOL_DAILY_CALLS_CAP = 'invalid'; // Will be NaN

    const warnFn = vi.fn();
    const mockLog = { server: { warn: warnFn, error: () => {} } };
    ensureFreePoolBudgetBooted(mockLog);

    // Verify WARN was logged for invalid cap with fallback
    expect(warnFn).toHaveBeenCalledWith(
      expect.objectContaining({ fallback: 1500 }),
      expect.stringContaining('invalid')
    );

    // Store should still be wired, using fallback cap
    const budgetStore = getFreePoolBudget();
    expect(budgetStore).not.toBeNull();
  });

  it('ensureFreePoolBudgetBooted() records flight recorder error when init throws', () => {
    process.env.AZURE_STORAGE_ACCOUNT_URL = 'https://test.blob.core.windows.net';

    // Inject a throwing init function
    const throwingInit = () => {
      throw new Error('Simulated init failure');
    };

    const errorFn = vi.fn();
    const mockLog = { server: { warn: () => {}, error: errorFn } };

    // Call should not throw; error is logged instead
    expect(() => ensureFreePoolBudgetBooted(mockLog, throwingInit)).not.toThrow();

    // Verify error was logged
    expect(errorFn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining('initialization failed')
    );

    // A failed init must leave the store unwired, so /health reports wired:false
    expect(getFreePoolBudget()).toBeNull();
  });

  it('t/4733: routes to staging-user-content when AZURE_USER_CONTENT_CONTAINER=staging-user-content', () => {
    // Regression test: verify container routing for prod/staging isolation
    process.env.AZURE_STORAGE_ACCOUNT_URL = 'https://test.blob.core.windows.net';
    process.env.AZURE_USER_CONTENT_CONTAINER = 'staging-user-content';

    // Capture what container was passed to init
    const capturedOpts: any[] = [];
    const capturingInit = (opts: any) => {
      capturedOpts.push(opts);
      return {}; // Return a mock store
    };

    const mockLog = { server: { warn: () => {}, error: () => {} } };
    ensureFreePoolBudgetBooted(mockLog, capturingInit);

    // Verify init was called with the correct container (staging)
    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0]).toHaveProperty('container', 'staging-user-content');
  });

  it('t/4733: falls back to user-content when AZURE_USER_CONTENT_CONTAINER is unset', () => {
    // Regression test: verify fallback for prod (where env var is not yet set by Bicep, t/4728)
    process.env.AZURE_STORAGE_ACCOUNT_URL = 'https://test.blob.core.windows.net';
    delete process.env.AZURE_USER_CONTENT_CONTAINER; // Simulate unset (prod state until t/4728)

    // Capture what container was passed to init
    const capturedOpts: any[] = [];
    const capturingInit = (opts: any) => {
      capturedOpts.push(opts);
      return {}; // Return a mock store
    };

    const warnFn = vi.fn();
    const mockLog = { server: { warn: warnFn, error: () => {} } };
    ensureFreePoolBudgetBooted(mockLog, capturingInit);

    // Verify init was called with fallback container (prod)
    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0]).toHaveProperty('container', 'user-content');

    // Verify WARN was logged for fallback (error-handling rule: no silent fallbacks)
    expect(warnFn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining('AZURE_USER_CONTENT_CONTAINER')
    );
  });

  it('t/4733: the real boot records the container and cap /health reports', () => {
    expect(getFreePoolBudgetConfig()).toBeNull(); // unwired

    process.env.AZURE_STORAGE_ACCOUNT_URL = 'https://test.blob.core.windows.net';
    process.env.AZURE_USER_CONTENT_CONTAINER = 'staging-user-content';
    process.env.FREE_POOL_DAILY_CALLS_CAP = '5';
    ensureFreePoolBudgetBooted({ server: { warn: () => {}, error: () => {} } });

    expect(getFreePoolBudgetConfig()).toEqual({ container: 'staging-user-content', callsCap: 5 });
    expect(freePoolBudgetHealth()).toEqual(expect.objectContaining({
      wired: true, container: 'staging-user-content', callsCap: 5,
    }));
  });

  it('t/4733: /health block reports wired:false with null container and cap when unwired', () => {
    expect(freePoolBudgetHealth()).toEqual(expect.objectContaining({ wired: false, container: null, callsCap: null }));
  });
});
