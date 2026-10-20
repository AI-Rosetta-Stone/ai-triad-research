// @vitest-environment node

/**
 * t/4162 (TL t/4031#1-3; SO e/297#4) — `ai.refreshAIModels()` delegates to the shared lib's
 * `refreshAIModels` (lib/electron-shared/modelDiscovery.ts, t/4160), mocked here so these tests
 * drive only the server-side wiring: the dryRun-coercion gate (SO C1), the host-set `principal`
 * (C3), and the `coerced: true` result flag (SO risk 2). The lib's own discovery/proposal/write
 * logic is covered by modelDiscovery.test.ts and its siblings.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { libRefreshMock, getCurrentUserIdMock, recordMock } = vi.hoisted(() => ({
  libRefreshMock: vi.fn(async () => ({
    gemini: { ok: true, count: 1 }, claude: { ok: true, count: 1 }, groq: { ok: true, count: 1 },
    openai: { ok: true, count: 1 }, deepseek: { ok: true, count: 1 }, ollama: { ok: true, count: 0 },
    totalModels: 5, written: false, dryRun: true,
  })),
  getCurrentUserIdMock: vi.fn(() => 'test-principal'),
  recordMock: vi.fn(),
}));

vi.mock('../../../../lib/electron-shared/modelDiscovery.js', () => ({ refreshAIModels: libRefreshMock }));
vi.mock('../security/userContext.js', () => ({ getCurrentUserId: getCurrentUserIdMock }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));
vi.mock('../config.js', async (importActual) => ({
  ...(await importActual<typeof import('../config.js')>()),
  getApiKeyForListing: vi.fn(async () => 'test-key'),
  getProjectRoot: () => '/fake/repo/root',
}));

import { refreshAIModels, clearRefreshAIModelsCacheForTests } from '../ai/aiBackends.js';

const PROPOSAL = { catalogFingerprint: 'fp1', hash: 'h1', changes: [] };

beforeEach(() => {
  libRefreshMock.mockClear();
  getCurrentUserIdMock.mockClear();
  recordMock.mockClear();
  clearRefreshAIModelsCacheForTests();
});

describe('refreshAIModels — dryRun coercion (SO C1)', () => {
  it('a plain call (no dryRun, no accept) is coerced to dryRun, WARNs, and flags coerced:true', async () => {
    const result = await refreshAIModels({});
    expect(libRefreshMock).toHaveBeenCalledWith(expect.anything(), { dryRun: true });
    expect(result.coerced).toBe(true);
    const warn = recordMock.mock.calls.find(([e]) => e.level === 'warn');
    expect(warn?.[0].message).toMatch(/coerced to dryRun/);
    expect(warn?.[0].message).toContain('test-principal');
  });

  it('an explicit dryRun:true call is NOT coerced (the caller already asked for a dry run)', async () => {
    const result = await refreshAIModels({ dryRun: true });
    expect(libRefreshMock).toHaveBeenCalledWith(expect.anything(), { dryRun: true });
    expect(result.coerced).toBeUndefined();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('a non-dryRun call WITH accept is not coerced — dryRun flows through as the caller sent it', async () => {
    await refreshAIModels({ accept: { proposal: PROPOSAL, approvedBy: 'Alice', reason: 'r' } });
    expect(libRefreshMock).toHaveBeenCalledWith(
      expect.anything(),
      { dryRun: undefined, accept: { proposal: PROPOSAL, approvedBy: 'Alice', reason: 'r', principal: 'test-principal' } },
    );
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('accept always carries the host-set principal, never anything from the caller', async () => {
    await refreshAIModels({ accept: { proposal: PROPOSAL, approvedBy: 'Alice', reason: 'r' } });
    const [, opts] = libRefreshMock.mock.calls[0];
    expect((opts as { accept: { principal: string } }).accept.principal).toBe('test-principal');
  });
});

describe('refreshAIModels — dry-run cache (t/4162 C5, t/4318)', () => {
  it('a second dry-run call within the TTL is served from cache — the lib is not re-invoked', async () => {
    const first = await refreshAIModels({ dryRun: true });
    const second = await refreshAIModels({ dryRun: true });
    expect(libRefreshMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('a coerced call shares the same cache as an explicit dryRun:true call', async () => {
    await refreshAIModels({ dryRun: true });
    const coercedResult = await refreshAIModels({}); // no dryRun, no accept → coerced
    expect(libRefreshMock).toHaveBeenCalledTimes(1);
    expect(coercedResult.coerced).toBe(true);
  });

  it('a cache hit still stamps coerced:true for a coerced caller, even though the cached result itself was not coerced', async () => {
    await refreshAIModels({ dryRun: true }); // populates cache with an uncoerced result
    const coercedResult = await refreshAIModels({});
    expect(coercedResult.coerced).toBe(true);
    expect(coercedResult.totalModels).toBe(5); // same underlying cached data
  });

  it('expires after the TTL — a call past expiry re-invokes the lib', async () => {
    vi.useFakeTimers();
    try {
      await refreshAIModels({ dryRun: true });
      vi.advanceTimersByTime(60_001);
      await refreshAIModels({ dryRun: true });
      expect(libRefreshMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a write (accept) bypasses the cache — always calls the lib live', async () => {
    await refreshAIModels({ dryRun: true }); // populate cache
    await refreshAIModels({ accept: { proposal: PROPOSAL, approvedBy: 'Alice', reason: 'r' } });
    expect(libRefreshMock).toHaveBeenCalledTimes(2);
  });

  it('a write invalidates the cache — the next dry-run after an accept is fresh, not stale', async () => {
    await refreshAIModels({ dryRun: true }); // populate cache (call 1)
    await refreshAIModels({ accept: { proposal: PROPOSAL, approvedBy: 'Alice', reason: 'r' } }); // call 2, invalidates
    await refreshAIModels({ dryRun: true }); // call 3 — must be live, not a stale cache hit
    expect(libRefreshMock).toHaveBeenCalledTimes(3);
  });
});
