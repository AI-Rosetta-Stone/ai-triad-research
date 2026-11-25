// @vitest-environment node
// t/494 (PI 2026-11-25, TL p/16#364): the free tier's daily per-visitor token limit is 1,500,000 by default.
import { describe, it, expect } from 'vitest';
import { getDefaults } from '../runtimeConfig.js';

describe('t/494: free-tier daily token limit', () => {
  it('defaults to 1,500,000 tokens per visitor per day', () => {
    expect(getDefaults().tiers.free.tokensPerDay).toBe(1_500_000);
  });
});
