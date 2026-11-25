// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/296: evidence-index key points can store `verbatim` as a string array. The grounding loop
// in runTurn.ts called .toLowerCase() on it and crashed the turn. keyPointText normalises it.

import { describe, it, expect } from 'vitest';
import { keyPointText } from './runTurn.js';

describe('keyPointText (t/296)', () => {
  it('passes a string through unchanged', () => {
    expect(keyPointText('a plain verbatim quote')).toBe('a plain verbatim quote');
  });

  it('joins a string array, the shape that crashed the turn', () => {
    expect(keyPointText(['first clause', 'second clause'])).toBe('first clause second clause');
  });

  it('drops non-string array members', () => {
    expect(keyPointText(['keep', 3, null, 'this'])).toBe('keep this');
  });

  it('returns undefined for missing or non-text values', () => {
    expect(keyPointText(undefined)).toBeUndefined();
    expect(keyPointText(null)).toBeUndefined();
    expect(keyPointText({ a: 1 })).toBeUndefined();
  });
});
