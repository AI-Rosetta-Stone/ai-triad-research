// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/725 step 4: the renderer's mirror of the server's Quick take shape (t/724#4 check A).

import { describe, it, expect } from 'vitest';
import { isQuickTakeShaped, isAnonReadOnly, anyDisabled } from './anonReadOnly';

const staging = (rounds: [number, number, number], step_mode?: boolean) => ({
  step_mode,
  phase_bounds_override: { maxConfrontationRounds: rounds[0], maxArgumentationRounds: rounds[1], maxConcludingRounds: rounds[2] },
});

describe('isQuickTakeShaped', () => {
  it('structured, 1/1/1, no step mode is a Quick take', () => {
    expect(isQuickTakeShaped({ protocol_id: 'structured', adaptive_staging: staging([1, 1, 1]) })).toBe(true);
    expect(isQuickTakeShaped({ protocol_id: 'structured', adaptive_staging: staging([1, 1, 1], false) })).toBe(true);
  });

  it.each([
    ['deliberation protocol', { protocol_id: 'deliberation', adaptive_staging: staging([1, 1, 1]) }],
    ['socratic protocol', { protocol_id: 'socratic', adaptive_staging: staging([1, 1, 1]) }],
    ['1/3/1 rounds', { protocol_id: 'structured', adaptive_staging: staging([1, 3, 1]) }],
    ['2 confrontation rounds', { protocol_id: 'structured', adaptive_staging: staging([2, 1, 1]) }],
    ['step mode', { protocol_id: 'structured', adaptive_staging: staging([1, 1, 1], true) }],
    ['no protocol', { adaptive_staging: staging([1, 1, 1]) }],
    ['no round override', { protocol_id: 'structured', adaptive_staging: { step_mode: false } }],
    ['no staging at all', { protocol_id: 'structured' }],
    ['a missing round', { protocol_id: 'structured', adaptive_staging: { phase_bounds_override: { maxConfrontationRounds: 1, maxArgumentationRounds: 1 } } }],
  ])('%s is not a Quick take', (_name, session) => {
    expect(isQuickTakeShaped(session)).toBe(false);
  });
});

describe('isAnonReadOnly', () => {
  const deep = { protocol_id: 'deliberation', adaptive_staging: staging([1, 3, 1]) };
  const quick = { protocol_id: 'structured', adaptive_staging: staging([1, 1, 1]) };
  it('only for an anonymous visitor and a non-Quick-take debate', () => {
    expect(isAnonReadOnly(true, deep)).toBe(true);
    expect(isAnonReadOnly(true, quick)).toBe(false);
    expect(isAnonReadOnly(false, deep)).toBe(false);
    expect(isAnonReadOnly(false, quick)).toBe(false);
  });
});

describe('anyDisabled', () => {
  it('is true when any reason is', () => {
    expect(anyDisabled(false, false, false)).toBe(false);
    expect(anyDisabled(false, true, false)).toBe(true);
  });
});
