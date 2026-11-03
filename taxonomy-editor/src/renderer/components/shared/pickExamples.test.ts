// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { pickExamples } from './pickExamples';

/** Deterministic seeded rng for tests — a simple LCG, not cryptographic, just reproducible. */
function seededRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

describe('pickExamples (t/4633)', () => {
  const pool = Array.from({ length: 15 }, (_, i) => `item-${i}`);

  it('returns exactly `count` items', () => {
    const result = pickExamples(pool, 3, seededRng(1));
    expect(result).toHaveLength(3);
  });

  it('never returns duplicates', () => {
    const result = pickExamples(pool, 10, seededRng(42));
    expect(new Set(result).size).toBe(result.length);
  });

  it('every returned item comes from the pool', () => {
    const result = pickExamples(pool, 5, seededRng(7));
    for (const item of result) expect(pool).toContain(item);
  });

  it('returns the pool unchanged (as a fresh array) when pool.length <= count', () => {
    const small = ['a', 'b'];
    const result = pickExamples(small, 5, seededRng(1));
    expect(result).toEqual(small);
    expect(result).not.toBe(small); // a copy, not the same reference
  });

  it('returns the pool unchanged when pool.length === count', () => {
    const small = ['a', 'b', 'c'];
    const result = pickExamples(small, 3, seededRng(1));
    expect(result.sort()).toEqual([...small].sort());
  });

  it('a given seeded rng produces a deterministic, reproducible selection', () => {
    const first = pickExamples(pool, 4, seededRng(99));
    const second = pickExamples(pool, 4, seededRng(99));
    expect(first).toEqual(second);
  });

  it('different seeds generally produce different selections (sanity, not a strict guarantee)', () => {
    const a = pickExamples(pool, 4, seededRng(1));
    const b = pickExamples(pool, 4, seededRng(2));
    expect(a).not.toEqual(b);
  });

  it('mustInclude: guarantees at least one picked item satisfies it when the pool has a match', () => {
    const withMarker = [...pool, 'MARKER'];
    // Run many seeds — mustInclude must hold for every one, not just by luck on one seed.
    for (let seed = 0; seed < 20; seed++) {
      const result = pickExamples(withMarker, 3, seededRng(seed), (x) => x === 'MARKER');
      expect(result.some((x) => x === 'MARKER')).toBe(true);
      expect(new Set(result).size).toBe(result.length); // still no duplicates
    }
  });

  it('mustInclude: never forces a match when the pool has none', () => {
    const result = pickExamples(pool, 3, seededRng(1), (x) => x === 'NOT-IN-POOL');
    expect(result).toHaveLength(3);
    expect(result.some((x) => x === 'NOT-IN-POOL')).toBe(false);
  });

  it('mustInclude is a no-op when count >= pool.length (whole pool returned anyway)', () => {
    const small = ['a', 'b', 'marker'];
    const result = pickExamples(small, 3, seededRng(1), (x) => x === 'marker');
    expect(result.sort()).toEqual([...small].sort());
  });

  it('defaults to Math.random when no rng is given (smoke test, not determinism)', () => {
    const result = pickExamples(pool, 3);
    expect(result).toHaveLength(3);
  });
});
