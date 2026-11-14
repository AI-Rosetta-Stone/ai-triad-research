// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/274 (Security p/232#22, Rosetta p/39#20): no more than MAX_CONCURRENT_CHILDREN isolated children run at once, across
// every caller in the process. A parse beyond that waits in a bounded queue; beyond the queue it is refused.

import { describe, it, expect } from 'vitest';
import { parseIsolated, runChildForTests, resolveFromModule, childSlotStats, MAX_CONCURRENT_CHILDREN, MAX_QUEUED_PARSES } from './isolatedParse.js';

const SLOW_CHILD = resolveFromModule('./isolated/__fixtures__/slow-child.mjs');
const bytes = () => new TextEncoder().encode('x');

describe('isolated child concurrency cap (t/274)', () => {
  it('the cap is 2, and a third concurrent parse waits for a slot instead of starting a child', async () => {
    expect(MAX_CONCURRENT_CHILDREN).toBe(2);
    const started = performance.now();
    const parses = [1, 2, 3].map(() => runChildForTests(SLOW_CHILD, 'pdf', bytes()));
    // The gate is synchronous, so the state is right the moment the parses are issued.
    expect(childSlotStats()).toEqual({ active: 2, queued: 1 });
    await Promise.all(parses);
    // Two slots run for about 1 s, then the third runs for another second: the total is about two seconds, not one.
    expect(performance.now() - started).toBeGreaterThan(1900);
    expect(childSlotStats()).toEqual({ active: 0, queued: 0 });
  }, 30_000);

  it('the cap holds across callers: a production parse counts against the same two slots', async () => {
    const parses = [
      runChildForTests(SLOW_CHILD, 'pdf', bytes()),
      runChildForTests(SLOW_CHILD, 'pdf', bytes()),
      parseIsolated('pdf', bytes()).catch((e) => e), // the production entry point: the real child, which fails fast on these bytes
    ];
    expect(childSlotStats()).toEqual({ active: 2, queued: 1 });
    await Promise.all(parses);
  }, 30_000);

  it('beyond the queue, a parse is refused with EXTRACTION_BUSY (429), and the refused one starts no child', async () => {
    const issued = [];
    for (let i = 0; i < MAX_CONCURRENT_CHILDREN + MAX_QUEUED_PARSES + 1; i++) {
      issued.push(runChildForTests(SLOW_CHILD, 'pdf', bytes()).then(() => null, (e) => e));
    }
    expect(childSlotStats()).toEqual({ active: MAX_CONCURRENT_CHILDREN, queued: MAX_QUEUED_PARSES });
    const outcomes = await Promise.all(issued);
    const refused = outcomes.filter((e) => e !== null);
    expect(refused).toHaveLength(1);
    expect(refused[0].code).toBe('EXTRACTION_BUSY');
    expect(refused[0].httpStatus).toBe(429);
    expect(childSlotStats()).toEqual({ active: 0, queued: 0 });
  }, 60_000);
});
