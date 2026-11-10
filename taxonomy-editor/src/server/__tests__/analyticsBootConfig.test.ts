// @vitest-environment node
//
// t/4954 (t/97): hosted mode must never fall back to prod's `analytics` container. Both arms of
// each rule are covered, plus a source guard that fails on the pre-fix server.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { warnMock, errorMock } = vi.hoisted(() => ({ warnMock: vi.fn(), errorMock: vi.fn() }));
vi.mock('../logger.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../logger.js')>();
  return { ...orig, log: { ...orig.log, analytics: { ...orig.log.analytics, warn: warnMock, error: errorMock } } };
});

import { resolveAnalyticsBootPlan, LOCAL_DEFAULT_ANALYTICS_CONTAINER } from '../analyticsBootConfig.js';
import { ActionableError } from '../../../../lib/debate/errors.js';

const URL = 'https://acct.blob.core.windows.net';

beforeEach(() => { warnMock.mockClear(); errorMock.mockClear(); });

describe('resolveAnalyticsBootPlan — hosted (NODE_ENV=production + account URL)', () => {
  it('var unset: disabled, never the `analytics` container, and logs an ActionableError naming the var', () => {
    const plan = resolveAnalyticsBootPlan({ NODE_ENV: 'production', AZURE_STORAGE_ACCOUNT_URL: URL });
    expect(plan.kind).toBe('disabled');
    expect(JSON.stringify(plan)).not.toContain('"container"');
    if (plan.kind !== 'disabled') throw new Error('unreachable');
    expect(plan.error).toBeInstanceOf(ActionableError);
    expect(plan.error.problem).toContain('AZURE_ANALYTICS_CONTAINER');
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(errorMock.mock.calls[0][0]).toMatchObject({ missing: 'AZURE_ANALYTICS_CONTAINER' });
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('var set: uses exactly that container, quietly', () => {
    const plan = resolveAnalyticsBootPlan({ NODE_ENV: 'production', AZURE_STORAGE_ACCOUNT_URL: URL, AZURE_ANALYTICS_CONTAINER: 'staging-analytics' });
    expect(plan).toEqual({ kind: 'azure-blob', accountUrl: URL, container: 'staging-analytics' });
    expect(errorMock).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe('resolveAnalyticsBootPlan — local (unchanged behaviour)', () => {
  it('no account URL: filesystem, hosted or not, with nothing logged', () => {
    expect(resolveAnalyticsBootPlan({ NODE_ENV: 'production' })).toEqual({ kind: 'filesystem' });
    expect(resolveAnalyticsBootPlan({})).toEqual({ kind: 'filesystem' });
    expect(errorMock).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('account URL but not production: keeps the local default container, and WARNs that it fell back', () => {
    const plan = resolveAnalyticsBootPlan({ AZURE_STORAGE_ACCOUNT_URL: URL });
    expect(plan).toEqual({ kind: 'azure-blob', accountUrl: URL, container: LOCAL_DEFAULT_ANALYTICS_CONTAINER });
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(errorMock).not.toHaveBeenCalled();
  });
});

describe('server.ts source guard (t/4954 regression)', () => {
  const serverSrc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.ts'), 'utf8');

  it('server.ts no longer reads AZURE_ANALYTICS_CONTAINER itself (it goes through resolveAnalyticsBootPlan)', () => {
    expect(serverSrc).not.toMatch(/process\.env\.AZURE_ANALYTICS_CONTAINER/);
    expect(serverSrc).toMatch(/resolveAnalyticsBootPlan\(\)/);
  });
});
