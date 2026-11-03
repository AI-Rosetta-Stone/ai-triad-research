// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { normalizeDebateOrigin } from './session.js';

describe('normalizeDebateOrigin', () => {
  it('maps the legacy inquiry string + sibling job id to the typed shape', () => {
    expect(normalizeDebateOrigin('inquiry', 'job-123')).toEqual({ mode: 'inquiry', inquiry_id: 'job-123' });
  });

  it('maps the legacy inquiry string with no job id to a bare inquiry origin', () => {
    expect(normalizeDebateOrigin('inquiry')).toEqual({ mode: 'inquiry' });
    expect(normalizeDebateOrigin('inquiry', undefined)).toEqual({ mode: 'inquiry' });
  });

  it('ignores a non-string job id alongside the legacy inquiry string', () => {
    expect(normalizeDebateOrigin('inquiry', 42)).toEqual({ mode: 'inquiry' });
  });

  it('passes an already-typed cli origin through unchanged', () => {
    const origin = { mode: 'cli' as const, command: 'npm run debate' };
    expect(normalizeDebateOrigin(origin)).toBe(origin);
  });

  it('passes an already-typed gui origin through unchanged', () => {
    const origin = { mode: 'gui' as const };
    expect(normalizeDebateOrigin(origin)).toBe(origin);
  });

  it('passes an already-typed inquiry origin through unchanged (no legacy reshaping)', () => {
    const origin = { mode: 'inquiry' as const, inquiry_id: 'job-456' };
    expect(normalizeDebateOrigin(origin)).toBe(origin);
  });

  it('returns undefined for a pre-origin debate (absent field)', () => {
    expect(normalizeDebateOrigin(undefined)).toBeUndefined();
  });

  it('returns undefined for unrecognized garbage input', () => {
    expect(normalizeDebateOrigin('something-else')).toBeUndefined();
    expect(normalizeDebateOrigin(42)).toBeUndefined();
    expect(normalizeDebateOrigin({ notMode: 'x' })).toBeUndefined();
    expect(normalizeDebateOrigin(null)).toBeUndefined();
  });
});
