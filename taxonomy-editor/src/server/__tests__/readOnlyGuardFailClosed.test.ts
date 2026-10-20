// @vitest-environment node
//
// t/4296 — SO condition G1 (e/323#2): proxy-tiers.json lives on the Azure Files share
// both environments mount and resolveConfigReadOnlyFlag's own catch fails OPEN on a
// read/parse failure — fine for an AI-quota setting, not fine for a containment
// control. READ_ONLY_PRINCIPALS is a static, no-I/O env list that cannot fail open.
//
// isEnvReadOnlyPrincipal reads process.env.READ_ONLY_PRINCIPALS at MODULE LOAD, so
// each scenario needs a fresh module instance with the env var set before import —
// hence vi.resetModules() + dynamic import per test, isolated from readOnlyGuard.test.ts's
// static import (which runs with the env var unset).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { resolveTierMock, warnMock, recordMock } = vi.hoisted(() => ({
  resolveTierMock: vi.fn(), warnMock: vi.fn(), recordMock: vi.fn(),
}));
vi.mock('../ai/proxyTiers.js', () => ({ resolveTier: resolveTierMock }));
vi.mock('../logger.js', () => ({ log: { server: { warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));

const ORIGINAL_ENV = process.env.READ_ONLY_PRINCIPALS;

beforeEach(() => { resolveTierMock.mockReset(); warnMock.mockClear(); recordMock.mockClear(); });
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.READ_ONLY_PRINCIPALS;
  else process.env.READ_ONLY_PRINCIPALS = ORIGINAL_ENV;
  vi.resetModules();
});

async function freshGuard(envValue: string | undefined) {
  if (envValue === undefined) delete process.env.READ_ONLY_PRINCIPALS;
  else process.env.READ_ONLY_PRINCIPALS = envValue;
  vi.resetModules();
  return import('../readOnlyGuard.js');
}

describe('t/4296 G1 — fail-closed env list stays blocked when proxy-tiers.json resolution throws', () => {
  it('FAULT ARM — resolveConfigReadOnlyFlag alone (no env entry) fails OPEN when resolveTier throws', async () => {
    const { resolveReadOnlyFlag } = await freshGuard(undefined); // no env-listed principals
    resolveTierMock.mockImplementation(() => { throw new Error('proxy-tiers.json unreadable (shared mount outage)'); });
    expect(resolveReadOnlyFlag('ai-triad-smoke', 'github')).toBe(false); // fails open — the exact risk SO flagged
  });

  it('SAFE ARM — an env-listed principal stays blocked even when resolveTier throws', async () => {
    const { resolveReadOnlyFlag } = await freshGuard('github:ai-triad-smoke');
    resolveTierMock.mockImplementation(() => { throw new Error('proxy-tiers.json unreadable (shared mount outage)'); });
    expect(resolveReadOnlyFlag('ai-triad-smoke', 'github')).toBe(true); // env source cannot fail open
  });

  it('a non-listed principal is unaffected by the env list and still follows proxy-tiers.json', async () => {
    const { resolveReadOnlyFlag } = await freshGuard('github:ai-triad-smoke');
    resolveTierMock.mockReturnValue({ level: 'byok', limits: {}, allowedBackends: [], readOnly: false });
    expect(resolveReadOnlyFlag('jpsnover', 'github')).toBe(false);
  });

  it('isEnvReadOnlyPrincipal is case-insensitive on the principal but idp-scoped', async () => {
    const { isEnvReadOnlyPrincipal } = await freshGuard('github:ai-triad-smoke');
    expect(isEnvReadOnlyPrincipal('AI-Triad-Smoke', 'github')).toBe(true);
    expect(isEnvReadOnlyPrincipal('ai-triad-smoke', 'aad')).toBe(false); // SO LOW finding — idp-scoped by design
  });

  it('supports a comma-separated list and ignores blank entries', async () => {
    const { isEnvReadOnlyPrincipal } = await freshGuard('github:ai-triad-smoke, , github:other-bot');
    expect(isEnvReadOnlyPrincipal('ai-triad-smoke', 'github')).toBe(true);
    expect(isEnvReadOnlyPrincipal('other-bot', 'github')).toBe(true);
    expect(isEnvReadOnlyPrincipal('jpsnover', 'github')).toBe(false);
  });

  it('an unset env var blocks no one via the env source (proxy-tiers.json is unaffected)', async () => {
    const { isEnvReadOnlyPrincipal } = await freshGuard(undefined);
    expect(isEnvReadOnlyPrincipal('ai-triad-smoke', 'github')).toBe(false);
  });
});
