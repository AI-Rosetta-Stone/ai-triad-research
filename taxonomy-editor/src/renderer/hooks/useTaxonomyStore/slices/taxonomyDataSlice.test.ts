// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4543: every launch opens the Rosetta Stone tool — for every user, including returning
// users (PI decision, t/4541#1). There is no "restore last tab" persistence for activeTab,
// so the slice's literal initial value IS the launch behavior; this pins that literal.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@bridge', () => ({ api: {} }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

const { createTaxonomyDataSlice } = await import('./taxonomyDataSlice');

describe('taxonomyDataSlice — initial activeTab (t/4543)', () => {
  it('defaults to rosetta-stone, not a POV tab, regardless of any prior session', () => {
    const set = () => {};
    const get = () => ({}) as never;
    const slice = createTaxonomyDataSlice(set as never, get, {} as never);
    expect(slice.activeTab).toBe('rosetta-stone');
  });
});
