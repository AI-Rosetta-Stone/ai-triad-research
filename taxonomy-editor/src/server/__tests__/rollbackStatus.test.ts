// @vitest-environment node

/**
 * t/871 — GET /api/admin/rollback/status backing logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getRollbackStatus, fetchKnownGoodTag, _resetKnownGoodCache } from '../rollbackStatus.js';

const ENV_KEYS = ['DEPLOY_SHA', 'DEPLOY_TAG', 'DEPLOY_TIMESTAMP', 'DEPLOY_IMAGE', 'CONTAINER_APP_REVISION', 'PREVIOUS_REVISION', 'KNOWN_GOOD_TAG', 'GHCR_PACKAGE'];
const SAVED: Record<string, string | undefined> = {};

/** Mock the GHCR token + tags-list calls. */
function mockGhcr(tags: string[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/token')) return { ok: true, json: async () => ({ token: 't0k' }) } as Response;
    if (url.includes('/tags/list')) return { ok: true, json: async () => ({ tags }) } as Response;
    return { ok: false } as Response;
  }));
}

describe('rollbackStatus (t/871)', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
    _resetKnownGoodCache();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
    vi.unstubAllGlobals();
    _resetKnownGoodCache();
  });

  it('maps deploy env vars and constructs the image tag', async () => {
    process.env.DEPLOY_SHA = 'abc1234';
    process.env.DEPLOY_TAG = '0.8.1';
    process.env.CONTAINER_APP_REVISION = 'taxonomy-editor--deploy-abc1234-5678';
    mockGhcr(['0.8.1', '0.8.0', '0.7.9']);

    const s = await getRollbackStatus();
    expect(s.deploySha).toBe('abc1234');
    expect(s.deployTag).toBe('0.8.1');
    expect(s.activeRevision).toBe('taxonomy-editor--deploy-abc1234-5678');
    expect(s.imageTag).toBe('ghcr.io/ai-rosetta-stone/taxonomy-editor:0.8.1');
    expect(s.knownGoodTag).toBe('0.8.0'); // highest semver below 0.8.1
  });

  it('returns null for missing fields (AC#4)', async () => {
    mockGhcr([]); // no tags
    const s = await getRollbackStatus();
    expect(s.deploySha).toBeNull();
    expect(s.deployTag).toBeNull();
    expect(s.activeRevision).toBeNull();
    expect(s.deployTimestamp).toBeNull();
    expect(s.imageTag).toBeNull();
    expect(s.previousRevision).toBeNull();
    expect(s.knownGoodTag).toBeNull();
  });

  it('prefers an explicit DEPLOY_IMAGE over the constructed tag', async () => {
    process.env.DEPLOY_IMAGE = 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:deadbeef';
    process.env.DEPLOY_TAG = '0.8.1';
    mockGhcr(['0.8.1', '0.8.0']);
    const s = await getRollbackStatus();
    expect(s.imageTag).toBe('ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:deadbeef');
  });

  it('fetchKnownGoodTag picks the highest semver strictly below the current tag', async () => {
    mockGhcr(['0.9.0', '0.8.2', '0.8.1', 'latest', 'edge']);
    expect(await fetchKnownGoodTag('0.8.2')).toBe('0.8.1');
  });

  it('falls back to KNOWN_GOOD_TAG env when the GHCR fetch fails', async () => {
    process.env.KNOWN_GOOD_TAG = '0.7.0';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await fetchKnownGoodTag('0.8.1')).toBe('0.7.0');
  });

  it('caches the known-good lookup (second call does not re-fetch)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/token')) return { ok: true, json: async () => ({ token: 't0k' }) } as Response;
      return { ok: true, json: async () => ({ tags: ['0.8.1', '0.8.0'] }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    await fetchKnownGoodTag('0.8.1');
    const callsAfterFirst = fetchMock.mock.calls.length;
    await fetchKnownGoodTag('0.8.1');
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // served from cache
  });
});
