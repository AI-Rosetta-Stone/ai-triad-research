// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4298/t/4299 — validateCacheDirDisjoint(): WARN (not throw — gate-promotion
// is a separate T2, TL t/4299#2) when the github-api disk cache dir and
// AI_TRIAD_DATA_ROOT are the same or nested either way. No-op on filesystem
// mode, which relies on the two being aligned (t/2061) — this check must
// never flag that mode.
//
// STORAGE_MODE/CACHE_DIR are read once at config.ts module load, so every
// test stubs env first and re-imports via vi.resetModules().

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let recordedEvents: Array<{ level?: string; message?: string; type?: string; data?: Record<string, unknown> }> = [];
vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: () => ({ record: (ev: unknown) => { recordedEvents.push(ev as never); } }),
  redactRecord: (r: unknown) => r,
}));

const warnCalls: unknown[][] = [];
vi.mock('../logger.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const logActual = actual.log as Record<string, { warn: (...a: unknown[]) => void }>;
  return {
    ...actual,
    log: { ...logActual, storage: { ...logActual.storage, warn: (...args: unknown[]) => warnCalls.push(args) } },
  };
});

async function loadWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  recordedEvents = [];
  warnCalls.length = 0;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, '');
    else vi.stubEnv(k, v);
  }
  if (env.AI_TRIAD_DATA_ROOT === undefined) vi.unstubAllEnvs(); // start clean, then re-apply below
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const mod = await import('../storage/dataRootValidator.js');
  return mod.validateCacheDirDisjoint;
}

describe('validateCacheDirDisjoint (t/4298/t/4299)', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    process.env = { ...savedEnv };
    vi.unstubAllEnvs();
  });

  it('WARNs (never throws) when CACHE_DIR equals AI_TRIAD_DATA_ROOT on github-api mode', async () => {
    const validateCacheDirDisjoint = await loadWithEnv({
      STORAGE_MODE: 'github-api',
      AI_TRIAD_DATA_ROOT: '/mnt/shared',
      TAXONOMY_CACHE_DIR: '/mnt/shared',
    });

    expect(() => validateCacheDirDisjoint()).not.toThrow();
    expect(warnCalls.length).toBe(1);
    const rateEvent = recordedEvents.find(e => e.type === 'storage.fallback');
    expect(rateEvent?.level).toBe('warn');
    expect(rateEvent?.message).toContain('not disjoint');
  });

  it('WARNs when CACHE_DIR is nested inside AI_TRIAD_DATA_ROOT', async () => {
    const validateCacheDirDisjoint = await loadWithEnv({
      STORAGE_MODE: 'github-api',
      AI_TRIAD_DATA_ROOT: '/mnt/shared',
      TAXONOMY_CACHE_DIR: '/mnt/shared/github-cache',
    });

    validateCacheDirDisjoint();
    expect(warnCalls.length).toBe(1);
  });

  it('WARNs when AI_TRIAD_DATA_ROOT is nested inside CACHE_DIR', async () => {
    const validateCacheDirDisjoint = await loadWithEnv({
      STORAGE_MODE: 'github-api',
      AI_TRIAD_DATA_ROOT: '/mnt/shared/data',
      TAXONOMY_CACHE_DIR: '/mnt/shared',
    });

    validateCacheDirDisjoint();
    expect(warnCalls.length).toBe(1);
  });

  it('passes silently when the two are disjoint', async () => {
    const validateCacheDirDisjoint = await loadWithEnv({
      STORAGE_MODE: 'github-api',
      AI_TRIAD_DATA_ROOT: '/mnt/shared',
      TAXONOMY_CACHE_DIR: '/home/app/.cache/taxonomy-github-api',
    });

    validateCacheDirDisjoint();
    expect(warnCalls.length).toBe(0);
    expect(recordedEvents).toHaveLength(0);
  });

  it('is a no-op on filesystem mode even when the dirs coincide (t/2061 alignment is intentional there)', async () => {
    const validateCacheDirDisjoint = await loadWithEnv({
      STORAGE_MODE: 'filesystem',
      AI_TRIAD_DATA_ROOT: '/mnt/shared',
      TAXONOMY_CACHE_DIR: '/mnt/shared',
    });

    validateCacheDirDisjoint();
    expect(warnCalls.length).toBe(0);
    expect(recordedEvents).toHaveLength(0);
  });

  it('is a no-op when AI_TRIAD_DATA_ROOT is unset (nothing to collide with)', async () => {
    const validateCacheDirDisjoint = await loadWithEnv({
      STORAGE_MODE: 'github-api',
      AI_TRIAD_DATA_ROOT: undefined,
      TAXONOMY_CACHE_DIR: '/mnt/shared',
    });

    validateCacheDirDisjoint();
    expect(warnCalls.length).toBe(0);
  });
});
