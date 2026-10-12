// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Tests for the computeModelFingerprint pure helper (t/4040).
 *
 * Coverage requirements from SO/CL review (e/265#13, #14):
 * - apiModelId repoint under fixed registryId → new key (proves the fingerprint uses live apiModelId)
 * - debateTiers change → new pool
 * - eligible set change → new pool
 * - permutation-invariant: same eligible set, different ordering → same key (sort guarantees)
 * - single-model run (tier=undefined) → model_api_id only
 * - single-model with modelTier set but tier arg=undefined → model_api_id (caller's responsibility to gate)
 * - eligible absent on multi-provider run → {} (WARN, row goes to model-mixed)
 * - registry absent → {}
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeModelFingerprint } from './modelFingerprint.js';
import type { ModelRegistry } from '../../ai-client/registry.js';

vi.mock('../../flight-recorder/index.js', () => ({
  getGlobalRecorder: () => null,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function makeRegistry(overrides?: Partial<ModelRegistry>): ModelRegistry {
  return {
    models: [
      { id: 'claude-sonnet-5', apiModelId: 'claude-sonnet-5-20251101', backend: 'claude' },
      { id: 'gemini-2.5-flash', apiModelId: 'gemini-2.5-flash-exp', backend: 'gemini' },
      { id: 'llama-3', apiModelId: 'llama-3-70b-8192', backend: 'groq' },
    ],
    debateTiers: {
      basic: {
        claude: 'claude-sonnet-5',
        gemini: 'gemini-2.5-flash',
      },
    },
    ...overrides,
  } as unknown as ModelRegistry;
}

describe('computeModelFingerprint — multi-provider (tier + eligible)', () => {
  it('builds a sorted pool from eligible backends (t/4040)', () => {
    const result = computeModelFingerprint(
      makeRegistry(),
      'basic',
      ['claude', 'gemini'],
      'claude-sonnet-5',
    );
    expect(result.model_pool).toBe(
      'basic|claude=claude-sonnet-5:claude-sonnet-5-20251101,gemini=gemini-2.5-flash:gemini-2.5-flash-exp',
    );
    expect(result.model_api_id).toBeUndefined();
  });

  it('permutation-invariant: same eligible set in different order → same key (t/4040)', () => {
    const a = computeModelFingerprint(makeRegistry(), 'basic', ['claude', 'gemini'], 'claude-sonnet-5');
    const b = computeModelFingerprint(makeRegistry(), 'basic', ['gemini', 'claude'], 'claude-sonnet-5');
    expect(a.model_pool).toBe(b.model_pool);
  });

  it('apiModelId repoint under fixed registryId → new model_pool (t/4040)', () => {
    const original = computeModelFingerprint(makeRegistry(), 'basic', ['claude', 'gemini'], 'claude-sonnet-5');

    const repointedRegistry = makeRegistry({
      models: [
        { id: 'claude-sonnet-5', apiModelId: 'claude-sonnet-5-20260101', backend: 'claude' }, // repointed
        { id: 'gemini-2.5-flash', apiModelId: 'gemini-2.5-flash-exp', backend: 'gemini' },
      ],
    } as Partial<ModelRegistry>);
    const repointed = computeModelFingerprint(repointedRegistry, 'basic', ['claude', 'gemini'], 'claude-sonnet-5');

    expect(original.model_pool).not.toBe(repointed.model_pool);
    expect(repointed.model_pool).toContain('claude-sonnet-5-20260101');
  });

  it('debateTiers change → new pool (t/4040)', () => {
    const original = computeModelFingerprint(makeRegistry(), 'basic', ['claude', 'gemini'], 'claude-sonnet-5');

    const changedTierRegistry = makeRegistry({
      debateTiers: { basic: { claude: 'claude-sonnet-5', gemini: 'llama-3' } }, // gemini now points to llama-3
    } as Partial<ModelRegistry>);
    const changed = computeModelFingerprint(changedTierRegistry, 'basic', ['claude', 'gemini'], 'claude-sonnet-5');

    expect(original.model_pool).not.toBe(changed.model_pool);
    expect(changed.model_pool).toContain('gemini=llama-3:llama-3-70b-8192');
  });

  it('eligible set change → new pool (t/4040)', () => {
    const twoBackends = computeModelFingerprint(
      makeRegistry(),
      'basic',
      ['claude', 'gemini'],
      'claude-sonnet-5',
    );
    const oneBackend = computeModelFingerprint(
      makeRegistry(),
      'basic',
      ['claude'],
      'claude-sonnet-5',
    );
    expect(twoBackends.model_pool).not.toBe(oneBackend.model_pool);
    expect(oneBackend.model_pool).toBe('basic|claude=claude-sonnet-5:claude-sonnet-5-20251101');
  });

  it('filters eligible to tierMap entries only — unknown backends are silently excluded', () => {
    const result = computeModelFingerprint(
      makeRegistry(),
      'basic',
      ['claude', 'unknownBackend'],
      'claude-sonnet-5',
    );
    expect(result.model_pool).toBe('basic|claude=claude-sonnet-5:claude-sonnet-5-20251101');
  });

  it('returns {} when eligible provided but no backends match tier (model-mixed)', () => {
    const result = computeModelFingerprint(
      makeRegistry(),
      'basic',
      ['groq'], // groq not in debateTiers.basic
      'claude-sonnet-5',
    );
    expect(result).toEqual({});
  });

  it('returns {} when eligible is absent (model-mixed, WARN)', () => {
    const result = computeModelFingerprint(
      makeRegistry(),
      'basic',
      undefined,
      'claude-sonnet-5',
    );
    expect(result).toEqual({});
  });

  it('falls through to single-model when tier has no tierMap entry', () => {
    const result = computeModelFingerprint(
      makeRegistry(),
      'nonexistent-tier',
      ['claude'],
      'claude-sonnet-5',
    );
    // No tierMap for 'nonexistent-tier' → falls through to single-model path
    expect(result.model_api_id).toBe('claude-sonnet-5:claude-sonnet-5-20251101');
    expect(result.model_pool).toBeUndefined();
  });
});

describe('computeModelFingerprint — single-model (tier=undefined)', () => {
  it('builds model_api_id from registryId:apiModelId (t/4040)', () => {
    const result = computeModelFingerprint(
      makeRegistry(),
      undefined,
      undefined,
      'gemini-2.5-flash',
    );
    expect(result.model_api_id).toBe('gemini-2.5-flash:gemini-2.5-flash-exp');
    expect(result.model_pool).toBeUndefined();
  });

  it('apiModelId repoint under fixed registryId → new model_api_id (t/4040)', () => {
    const original = computeModelFingerprint(makeRegistry(), undefined, undefined, 'gemini-2.5-flash');

    const repointedRegistry = makeRegistry({
      models: [
        { id: 'claude-sonnet-5', apiModelId: 'claude-sonnet-5-20251101', backend: 'claude' },
        { id: 'gemini-2.5-flash', apiModelId: 'gemini-2.5-flash-2026', backend: 'gemini' }, // repointed
      ],
    } as Partial<ModelRegistry>);
    const repointed = computeModelFingerprint(repointedRegistry, undefined, undefined, 'gemini-2.5-flash');

    expect(original.model_api_id).not.toBe(repointed.model_api_id);
    expect(repointed.model_api_id).toBe('gemini-2.5-flash:gemini-2.5-flash-2026');
  });

  it('falls back to registryId when apiModelId missing from registry', () => {
    const registryWithoutApiId = makeRegistry({
      models: [{ id: 'mystery-model', backend: 'groq' } as unknown as ModelRegistry['models'][0]],
    } as Partial<ModelRegistry>);
    const result = computeModelFingerprint(registryWithoutApiId, undefined, undefined, 'mystery-model');
    expect(result.model_api_id).toBe('mystery-model:mystery-model');
  });

  it('falls back to registryId when model not found in registry', () => {
    const result = computeModelFingerprint(makeRegistry(), undefined, undefined, 'unknown-model');
    expect(result.model_api_id).toBe('unknown-model:unknown-model');
  });
});

describe('computeModelFingerprint — registry absent', () => {
  it('returns {} when registry is undefined', () => {
    expect(computeModelFingerprint(undefined, 'basic', ['claude'], 'claude-sonnet-5')).toEqual({});
  });

  it('returns {} when registry is undefined (single-model path)', () => {
    expect(computeModelFingerprint(undefined, undefined, undefined, 'claude-sonnet-5')).toEqual({});
  });
});

describe('computeModelFingerprint — stage-model suffix (t/4127)', () => {
  it('no overrides: single-model fingerprint is byte-identical to today', () => {
    const withoutOverrides = computeModelFingerprint(makeRegistry(), undefined, undefined, 'gemini-2.5-flash');
    const withUndefinedOverrides = computeModelFingerprint(makeRegistry(), undefined, undefined, 'gemini-2.5-flash', undefined);
    expect(withoutOverrides.model_api_id).toBe('gemini-2.5-flash:gemini-2.5-flash-exp');
    expect(withUndefinedOverrides.model_api_id).toBe('gemini-2.5-flash:gemini-2.5-flash-exp');
  });

  it('no overrides: multi-provider fingerprint is byte-identical to today', () => {
    const withoutOverrides = computeModelFingerprint(makeRegistry(), 'basic', ['claude', 'gemini'], 'claude-sonnet-5');
    const withUndefinedOverrides = computeModelFingerprint(makeRegistry(), 'basic', ['claude', 'gemini'], 'claude-sonnet-5', undefined);
    const expected = 'basic|claude=claude-sonnet-5:claude-sonnet-5-20251101,gemini=gemini-2.5-flash:gemini-2.5-flash-exp';
    expect(withoutOverrides.model_pool).toBe(expected);
    expect(withUndefinedOverrides.model_pool).toBe(expected);
  });

  it('one stage override: single-model gets suffix, producing a different key', () => {
    const base = computeModelFingerprint(makeRegistry(), undefined, undefined, 'claude-sonnet-5');
    const withOverride = computeModelFingerprint(makeRegistry(), undefined, undefined, 'claude-sonnet-5', { brief: 'gemini-2.5-flash' });
    expect(withOverride.model_api_id).toBe('claude-sonnet-5:claude-sonnet-5-20251101;st=brief=gemini-2.5-flash:gemini-2.5-flash-exp');
    expect(withOverride.model_api_id).not.toBe(base.model_api_id);
  });

  it('one stage override: multi-provider gets suffix', () => {
    const withOverride = computeModelFingerprint(makeRegistry(), 'basic', ['claude', 'gemini'], 'claude-sonnet-5', { cite: 'llama-3' });
    expect(withOverride.model_pool).toBe(
      'basic|claude=claude-sonnet-5:claude-sonnet-5-20251101,gemini=gemini-2.5-flash:gemini-2.5-flash-exp;st=cite=llama-3:llama-3-70b-8192',
    );
  });

  it('same overrides in different object-key order → same suffix (sorted by stage name)', () => {
    const a = computeModelFingerprint(makeRegistry(), undefined, undefined, 'claude-sonnet-5', { cite: 'llama-3', brief: 'gemini-2.5-flash' });
    const b = computeModelFingerprint(makeRegistry(), undefined, undefined, 'claude-sonnet-5', { brief: 'gemini-2.5-flash', cite: 'llama-3' });
    expect(a.model_api_id).toBe(b.model_api_id);
    expect(a.model_api_id).toContain(';st=brief=gemini-2.5-flash:gemini-2.5-flash-exp,cite=llama-3:llama-3-70b-8192');
  });

  it('override equal to debate model still appends the suffix', () => {
    // Over-splitting is safe; wrong pooling is not (t/4098 design rule).
    const base = computeModelFingerprint(makeRegistry(), undefined, undefined, 'claude-sonnet-5');
    const withSameModel = computeModelFingerprint(makeRegistry(), undefined, undefined, 'claude-sonnet-5', { brief: 'claude-sonnet-5' });
    expect(withSameModel.model_api_id).toContain(';st=brief=claude-sonnet-5:claude-sonnet-5-20251101');
    expect(withSameModel.model_api_id).not.toBe(base.model_api_id);
  });
});
