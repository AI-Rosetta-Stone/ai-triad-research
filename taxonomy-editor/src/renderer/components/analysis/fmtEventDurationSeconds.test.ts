// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { fmtEventDurationSeconds } from './AnalyticsDashboard';

describe('fmtEventDurationSeconds (t/320, Design t/337)', () => {
  // Test cases: sub-second handling, boundary, and larger values
  const testCases = [
    { ms: 0, expected: '0s', label: 'exactly 0' },
    { ms: 1, expected: '<1s', label: 'sub-second (1ms)' },
    { ms: 499, expected: '<1s', label: 'sub-second boundary (499ms)' },
    { ms: 500, expected: '1s', label: 'rounding boundary (500ms)' },
    { ms: 4949, expected: '5s', label: 'round down (4949ms)' },
    { ms: 31647, expected: '32s', label: 'large value (31647ms)' },
  ];

  testCases.forEach(({ ms, expected, label }) => {
    it(`should convert ${ms}ms to "${expected}" (${label})`, () => {
      const result = fmtEventDurationSeconds(ms);
      expect(result).toBe(expected);
    });
  });
});

