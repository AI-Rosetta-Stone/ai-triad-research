// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/284 item 3: the renderer carries the literal question into the opening input for inquiry
// debates only. Normal debates get undefined, so their openings are unchanged.

import { describe, it, expect } from 'vitest';
import { openingAnchorQuestion } from './openingAnchorQuestion';

describe('openingAnchorQuestion (t/284 item 3)', () => {
  it('carries the question for an inquiry debate', () => {
    expect(openingAnchorQuestion({ origin: { mode: 'inquiry' } } as never, 'Does regulation slow AI progress?'))
      .toBe('Does regulation slow AI progress?');
  });

  it('is undefined for a non-inquiry debate', () => {
    expect(openingAnchorQuestion({ origin: { mode: 'debate' } } as never, 'Should AI be regulated?')).toBeUndefined();
  });

  it('is undefined when the debate has no origin', () => {
    expect(openingAnchorQuestion({} as never, 'Should AI be regulated?')).toBeUndefined();
  });
});
