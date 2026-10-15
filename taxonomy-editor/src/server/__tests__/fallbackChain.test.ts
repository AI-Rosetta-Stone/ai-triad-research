// @vitest-environment node

/**
 * t/829 — free-tier fallback chain must not pass the Gemini server key to
 * non-Gemini backends. filterChainForExplicitKey() drops cross-provider
 * fallbacks when an explicit key is supplied; without one, the full
 * cross-provider chain is kept.
 */

import { describe, it, expect } from 'vitest';
import { filterChainForExplicitKey, buildModelsToTry, resolveBackend } from '../ai/aiBackends.js';

// A deliberately cross-provider chain: gemini primary + a gemini fallback,
// then groq/claude (which a free-tier Gemini key could never authenticate).
const CROSS_PROVIDER = ['gemini-flash-lite-latest', 'gemini-2.0-flash', 'groq-llama-3.3-70b', 'claude-haiku'];

// t/4196 Stage 1: registry is `null` throughout this file — these tests are specifically about
// id-prefix-based cross-provider filtering, not registry lookups, so prefix-only is the point.
describe('filterChainForExplicitKey (t/829)', () => {
  it('drops cross-provider fallbacks when an explicit key is set', () => {
    const filtered = filterChainForExplicitKey(CROSS_PROVIDER, true, null);
    expect(filtered).toEqual(['gemini-flash-lite-latest', 'gemini-2.0-flash']);
    expect(filtered.every(m => resolveBackend(m) === 'gemini')).toBe(true);
  });

  it('keeps the full cross-provider chain when there is no explicit key', () => {
    // Per-backend keys are resolved individually, so other providers stay in play.
    expect(filterChainForExplicitKey(CROSS_PROVIDER, false, null)).toEqual(CROSS_PROVIDER);
  });

  it('preserves the primary model even if it is non-Gemini', () => {
    const claudeChain = ['claude-sonnet', 'gemini-2.0-flash', 'groq-llama'];
    expect(filterChainForExplicitKey(claudeChain, true, null)).toEqual(['claude-sonnet']);
  });

  it('is a no-op on an empty chain', () => {
    expect(filterChainForExplicitKey([], true, null)).toEqual([]);
  });
});

describe('buildModelsToTry (t/829 integration)', () => {
  it('always starts with the resolved model', () => {
    expect(buildModelsToTry('gemini-flash-lite-latest', true, null)[0]).toBe('gemini-flash-lite-latest');
    expect(buildModelsToTry('gemini-flash-lite-latest', false, null)[0]).toBe('gemini-flash-lite-latest');
  });

  it('with an explicit key, every attempted model is same-provider', () => {
    const chain = buildModelsToTry('gemini-flash-lite-latest', true, null);
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.every(m => resolveBackend(m) === 'gemini')).toBe(true);
  });
});
